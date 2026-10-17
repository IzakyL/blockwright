use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File},
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

/// Lifecycle events buffered for in-process subscribers. Process output lines are never
/// broadcast, so this only has to absorb bursts of agent and driver events.
const EVENT_CAPACITY: usize = 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceEvent {
    pub ts: String,
    pub seq: u64,
    pub instance_id: String,
    pub category: String,
    pub name: String,
    pub data: Value,
}

#[derive(Clone)]
pub struct TraceSink {
    inner: Arc<TraceSinkInner>,
}

struct TraceSinkInner {
    file: Mutex<File>,
    sequence: AtomicU64,
    instance_id: String,
    events: broadcast::Sender<Arc<TraceEvent>>,
    /// Newest event per name, so a subscriber that lags behind a burst still sees the latest
    /// ready or died event instead of silently skipping it.
    latest: Mutex<HashMap<String, Arc<TraceEvent>>>,
}

impl TraceSink {
    pub fn create(path: impl AsRef<Path>, instance_id: impl Into<String>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create trace dir {}", parent.display()))?;
        }
        let file = File::create(path)
            .with_context(|| format!("failed to create trace {}", path.display()))?;
        Ok(Self {
            inner: Arc::new(TraceSinkInner {
                file: Mutex::new(file),
                sequence: AtomicU64::new(1),
                instance_id: instance_id.into(),
                events: broadcast::channel(EVENT_CAPACITY).0,
                latest: Mutex::default(),
            }),
        })
    }

    pub fn write(
        &self,
        category: impl Into<String>,
        name: impl Into<String>,
        data: Value,
    ) -> Result<()> {
        let event = TraceEvent {
            ts: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            seq: self.inner.sequence.fetch_add(1, Ordering::SeqCst),
            instance_id: self.inner.instance_id.clone(),
            category: category.into(),
            name: name.into(),
            data,
        };
        let mut line = serde_json::to_vec(&event).context("failed to serialize trace event")?;
        if !is_process_output(&event.name) {
            let event = Arc::new(event);
            if let Ok(mut latest) = self.inner.latest.lock() {
                latest.insert(event.name.clone(), event.clone());
            }
            if self.inner.events.receiver_count() > 0 {
                let _ = self.inner.events.send(event);
            }
        }
        line.push(b'\n');
        let mut file = self
            .inner
            .file
            .lock()
            .map_err(|_| anyhow::anyhow!("trace mutex poisoned"))?;
        file.write_all(&line)
            .context("failed to write trace event")?;
        file.flush().context("failed to flush trace event")?;

        Ok(())
    }

    /// Subscribes to every event written after this call, except process output lines.
    pub fn subscribe(&self) -> TraceSubscription {
        TraceSubscription {
            receiver: self.inner.events.subscribe(),
            after: self.inner.sequence.load(Ordering::SeqCst).saturating_sub(1),
            backlog: VecDeque::new(),
            sink: self.clone(),
        }
    }
}

pub struct TraceSubscription {
    receiver: broadcast::Receiver<Arc<TraceEvent>>,
    sink: TraceSink,
    /// Sequence of the last event delivered (or of the last event before subscribing).
    after: u64,
    backlog: VecDeque<Arc<TraceEvent>>,
}

impl TraceSubscription {
    /// Returns the next event in write order, or `None` once the sink is gone. After a lag it
    /// resumes from the newest event of each name written since the last delivered one.
    pub async fn recv(&mut self) -> Option<Arc<TraceEvent>> {
        loop {
            let event = match self.backlog.pop_front() {
                Some(event) => event,
                None => match self.receiver.recv().await {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let mut missed: Vec<_> = self
                            .sink
                            .inner
                            .latest
                            .lock()
                            .map(|latest| {
                                latest
                                    .values()
                                    .filter(|e| e.seq > self.after)
                                    .cloned()
                                    .collect()
                            })
                            .unwrap_or_default();
                        missed.sort_by_key(|event| event.seq);
                        self.backlog.extend(missed);
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                },
            };
            if event.seq > self.after {
                self.after = event.seq;
                return Some(event);
            }
        }
    }
}

fn is_process_output(name: &str) -> bool {
    name == "process.stdout" || name == "process.stderr"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn a_lagged_subscription_still_sees_the_latest_event_of_each_name() {
        let sink =
            TraceSink::create(if cfg!(windows) { "NUL" } else { "/dev/null" }, "lagging").unwrap();
        let mut events = sink.subscribe();
        sink.write("agent", "blockwright.lifecycle.ready", json!({}))
            .unwrap();
        for index in 0..EVENT_CAPACITY * 2 {
            sink.write("agent", "noise", json!({ "index": index }))
                .unwrap();
        }
        let mut names = Vec::new();
        while let Ok(Some(event)) =
            tokio::time::timeout(std::time::Duration::from_millis(50), events.recv()).await
        {
            names.push(event.name.clone());
        }
        assert_eq!(
            names.first().map(String::as_str),
            Some("blockwright.lifecycle.ready")
        );
    }
}

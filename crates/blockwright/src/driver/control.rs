use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use anyhow::{Context, Result};
use blockwright::trace::TraceSink;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::{oneshot, Mutex, Notify},
    task::JoinHandle,
    time::{timeout, Duration},
};

const CONTROL_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the agent may take to answer a control request. Control carries only lifecycle
/// requests such as `game.connect`, which answer promptly; this only catches an agent that
/// stopped answering.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) type ControlWriter = Box<dyn AsyncWrite + Send + Unpin>;

pub(crate) struct ControlMux {
    writer: Mutex<Option<ControlWriter>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    closed: AtomicBool,
    closed_reason: Mutex<Option<String>>,
    /// Set when a request outlived its budget; the connection was dropped and every request fails
    /// fast with this reason until the agent reconnects.
    unhealthy: Mutex<Option<String>>,
    ready: Notify,
}

impl ControlMux {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            writer: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            closed_reason: Mutex::new(None),
            unhealthy: Mutex::new(None),
            ready: Notify::new(),
        })
    }

    #[cfg(test)]
    pub(crate) fn closed(reason: &str) -> Arc<Self> {
        let mux = Self::new();
        mux.closed.store(true, Ordering::SeqCst);
        *mux.closed_reason.try_lock().unwrap() = Some(reason.to_string());
        mux
    }

    #[cfg(test)]
    pub(crate) async fn connected(writer: ControlWriter) -> Arc<Self> {
        let mux = Self::new();
        mux.attach(writer).await;
        mux
    }

    pub(crate) async fn attach(&self, writer: ControlWriter) {
        *self.unhealthy.lock().await = None;
        *self.writer.lock().await = Some(writer);
        self.ready.notify_waiters();
    }

    pub(crate) async fn detach(&self) {
        *self.writer.lock().await = None;
        self.pending.lock().await.clear();
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub(crate) async fn close(&self, reason: impl Into<String>) {
        let reason = reason.into();
        self.closed.store(true, Ordering::SeqCst);
        *self.closed_reason.lock().await = Some(reason);
        *self.writer.lock().await = None;
        self.pending.lock().await.clear();
        self.ready.notify_waiters();
    }

    async fn closed_error(&self) -> anyhow::Error {
        let reason = self.closed_reason.lock().await.clone();
        anyhow::anyhow!(reason.unwrap_or_else(|| "control channel is closed".to_string()))
    }

    async fn wait_ready(&self) -> bool {
        timeout(CONTROL_CONNECT_TIMEOUT, async {
            loop {
                if self.closed.load(Ordering::SeqCst) {
                    return false;
                }
                if self.writer.lock().await.is_some() {
                    return true;
                }
                self.ready.notified().await;
            }
        })
        .await
        .unwrap_or(false)
    }

    pub(crate) async fn resolve(&self, id: u64, value: Value) {
        if let Some(sender) = self.pending.lock().await.remove(&id) {
            let _ = sender.send(value);
        }
    }

    async fn dispatch(&self, id: u64, frame: Value) -> Result<oneshot::Receiver<Value>> {
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);

        let mut payload = serde_json::to_string(&frame)?;
        payload.push('\n');

        let written = {
            let mut guard = self.writer.lock().await;
            match guard.as_mut() {
                Some(writer) => match writer.write_all(payload.as_bytes()).await {
                    Ok(()) => Some(writer.flush().await),
                    Err(error) => Some(Err(error)),
                },
                None => None,
            }
        };
        match written {
            Some(Ok(())) => Ok(receiver),
            Some(Err(error)) => {
                self.pending.lock().await.remove(&id);
                Err(anyhow::Error::new(error).context("failed to write control request"))
            }
            None => {
                self.pending.lock().await.remove(&id);
                Err(self.closed_error().await)
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct AgentControlHandle {
    mux: Arc<ControlMux>,
}

impl AgentControlHandle {
    pub(crate) fn over(mux: Arc<ControlMux>) -> Self {
        Self { mux }
    }

    pub(crate) fn spawn(listener: TcpListener, sink: TraceSink) -> (Self, JoinHandle<()>) {
        let mux = ControlMux::new();
        let handle = Self::over(mux.clone());
        let task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, peer)) => {
                        if let Err(error) = stream.set_nodelay(true) {
                            tracing::warn!(
                                "failed to set TCP_NODELAY on agent control stream: {error:#}"
                            );
                        }
                        let (read, write) = stream.into_split();
                        mux.attach(Box::new(write)).await;
                        let _ = sink.write(
                            "agent",
                            "agent.control.connected",
                            json!({ "peer": peer.to_string() }),
                        );
                        pump_agent_responses(mux.clone(), BufReader::new(read), Some(&sink)).await;
                        mux.detach().await;
                        let _ = sink.write(
                            "agent",
                            "agent.control.disconnected",
                            json!({ "peer": peer.to_string() }),
                        );
                    }
                    Err(error) => {
                        mux.close(format!("agent control listener failed: {error}"))
                            .await;
                        let _ = sink.write(
                            "agent",
                            "agent.control.error",
                            json!({ "error": error.to_string() }),
                        );
                        return;
                    }
                }
            }
        });

        (handle, task)
    }

    pub(crate) async fn reset(&self) {
        self.mux.detach().await;
    }

    /// Sends one agent method for `instance_id` and returns its `result`, failing when the
    /// channel is unavailable or the agent answers with an error.
    pub(crate) async fn call(
        &self,
        instance_id: &str,
        method: &str,
        mut params: Value,
    ) -> Result<Value> {
        params["instanceId"] = json!(instance_id);
        let response = self
            .request(json!({ "method": method, "params": params }))
            .await?;
        if let Some(error) = response.get("error") {
            anyhow::bail!("{}", error.get("message").unwrap_or(error));
        }
        response
            .get("result")
            .cloned()
            .context("agent returned no result")
    }

    pub(crate) async fn request(&self, request: Value) -> Result<Value> {
        self.request_within(request, CALL_TIMEOUT).await
    }

    async fn request_within(&self, mut request: Value, budget: Duration) -> Result<Value> {
        if let Some(reason) = self.mux.unhealthy.lock().await.clone() {
            anyhow::bail!(reason);
        }
        if !self.mux.wait_ready().await {
            if self.mux.is_closed() {
                return Err(self.mux.closed_error().await);
            }
            anyhow::bail!("the agent control channel did not connect");
        }

        let id = self.mux.next_id.fetch_add(1, Ordering::SeqCst);
        let method = request["method"].as_str().unwrap_or("unknown").to_string();
        if let Some(object) = request.as_object_mut() {
            object.insert("id".to_string(), json!(id));
        }
        let receiver = self.mux.dispatch(id, request).await?;
        match timeout(budget, receiver).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) if self.mux.is_closed() => Err(self.mux.closed_error().await),
            Ok(Err(_)) => anyhow::bail!("the agent disconnected before answering {method}"),
            Err(_) => {
                // The agent may still be running the call, so later requests would queue behind
                // it: drop the connection and fail fast until the agent reconnects.
                let reason = format!(
                    "agent control is unhealthy: {method} got no response within {}ms",
                    budget.as_millis()
                );
                *self.mux.unhealthy.lock().await = Some(reason.clone());
                self.mux.detach().await;
                anyhow::bail!(reason)
            }
        }
    }
}

/// Reads the agent's lines: responses resolve their pending request, and `trace` notifications
/// (frames without an id) go to the instance's trace.
pub(crate) async fn pump_agent_responses<R>(
    mux: Arc<ControlMux>,
    reader: R,
    sink: Option<&TraceSink>,
) where
    R: AsyncBufReadExt + Unpin,
{
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(mut response) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match response.get("id").and_then(Value::as_u64) {
            Some(id) => mux.resolve(id, response).await,
            None if response["method"] == "trace" => {
                if let Some(sink) = sink {
                    let event = response["params"].take();
                    let name = event["name"].as_str().unwrap_or("agent.event").to_string();
                    let _ = sink.write("agent", name, event);
                }
            }
            None => {}
        }
    }
}

#[cfg(test)]
pub(crate) async fn write_line<W>(writer: &mut W, frame: &Value) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    use anyhow::Context;
    let mut payload = serde_json::to_string(frame)?;
    payload.push('\n');
    writer
        .write_all(payload.as_bytes())
        .await
        .context("failed to write control frame")?;
    writer
        .flush()
        .await
        .context("failed to flush control frame")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn requests_stay_in_flight_together_and_match_their_own_ids() {
        let (near, far) = duplex(64 * 1024);
        let (far_read, mut far_write) = tokio::io::split(far);
        let (near_read, near_write) = tokio::io::split(near);
        let mux = ControlMux::connected(Box::new(near_write)).await;
        tokio::spawn(pump_agent_responses(
            mux.clone(),
            BufReader::new(near_read),
            None,
        ));
        let control = AgentControlHandle::over(mux.clone());

        tokio::spawn(async move {
            let mut requests = BufReader::new(far_read).lines();
            let mut seen = Vec::new();
            while let Ok(Some(line)) = requests.next_line().await {
                seen.push(serde_json::from_str::<Value>(&line).unwrap());
                if seen.len() < 3 {
                    continue;
                }
                for request in seen.drain(..).rev() {
                    let id = request.get("id").and_then(Value::as_u64).unwrap();
                    let method = request.get("method").and_then(Value::as_str).unwrap();
                    write_line(
                        &mut far_write,
                        &json!({ "id": id, "result": { "echo": method } }),
                    )
                    .await
                    .unwrap();
                }
            }
        });

        let (first, second, third) = tokio::join!(
            control.request(json!({ "method": "alpha" })),
            control.request(json!({ "method": "beta" })),
            control.request(json!({ "method": "gamma" })),
        );

        assert_eq!(first.unwrap()["result"]["echo"], json!("alpha"));
        assert_eq!(second.unwrap()["result"]["echo"], json!("beta"));
        assert_eq!(third.unwrap()["result"]["echo"], json!("gamma"));
    }

    #[tokio::test]
    async fn a_closed_channel_fails_requests_instead_of_hanging() {
        let (near, far) = duplex(1024);
        let (near_read, near_write) = tokio::io::split(near);
        let mux = ControlMux::connected(Box::new(near_write)).await;
        let control = AgentControlHandle::over(mux.clone());
        let pump = tokio::spawn({
            let mux = mux.clone();
            async move {
                pump_agent_responses(mux.clone(), BufReader::new(near_read), None).await;
                mux.close("owner is gone").await;
            }
        });

        drop(far);
        pump.await.unwrap();

        let error = control
            .request(json!({ "method": "alpha" }))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("owner is gone"));
    }

    #[tokio::test]
    async fn a_request_past_its_budget_marks_the_channel_unhealthy() {
        let (near, _far) = duplex(1024);
        let (_near_read, near_write) = tokio::io::split(near);
        let mux = ControlMux::connected(Box::new(near_write)).await;
        let control = AgentControlHandle::over(mux.clone());

        let error = control
            .request_within(
                json!({ "method": "slow", "params": {} }),
                Duration::from_millis(20),
            )
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("slow got no response within 20ms"));

        let started = std::time::Instant::now();
        let again = control
            .request(json!({ "method": "alpha", "params": {} }))
            .await
            .unwrap_err();
        assert!(again.to_string().contains("slow"));
        assert!(started.elapsed() < Duration::from_millis(20));

        let (near, far) = duplex(1024);
        let (near_read, near_write) = tokio::io::split(near);
        let (far_read, mut far_write) = tokio::io::split(far);
        mux.attach(Box::new(near_write)).await;
        tokio::spawn(pump_agent_responses(
            mux.clone(),
            BufReader::new(near_read),
            None,
        ));
        tokio::spawn(async move {
            let mut lines = BufReader::new(far_read).lines();
            let line = lines.next_line().await.unwrap().unwrap();
            let id = serde_json::from_str::<Value>(&line).unwrap()["id"].clone();
            write_line(&mut far_write, &json!({ "id": id, "result": {} }))
                .await
                .unwrap();
        });
        control
            .request(json!({ "method": "alpha", "params": {} }))
            .await
            .expect("a reconnected agent is healthy again");
    }

    #[tokio::test]
    async fn trace_notifications_go_to_the_trace() {
        let sink =
            TraceSink::create(if cfg!(windows) { "NUL" } else { "/dev/null" }, "traced").unwrap();
        let mut events = sink.subscribe();
        let lines = concat!(
            r#"{"method":"trace","params":{"name":"blockwright.lifecycle.ready","data":{"x":1}}}"#,
            "\n",
            r#"{"id":7,"result":{}}"#,
            "\n",
        );
        pump_agent_responses(
            ControlMux::new(),
            BufReader::new(lines.as_bytes()),
            Some(&sink),
        )
        .await;
        let event = events.recv().await.unwrap();
        assert_eq!(event.category, "agent");
        assert_eq!(event.name, "blockwright.lifecycle.ready");
        assert_eq!(event.data["data"]["x"], json!(1));
    }
}

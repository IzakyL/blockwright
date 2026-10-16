mod control;
mod launch;
pub(crate) mod types;

use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{mpsc, watch, Mutex},
};

use launch::RunningInstance;
use types::*;

type SharedInstances = Arc<Mutex<HashMap<String, RunningInstance>>>;

const SHUTDOWN_BUDGET: Duration = Duration::from_secs(60);
const EXIT_CLEANUP_INCOMPLETE: i32 = 75;
const INPUT_QUEUE_CAPACITY: usize = 64;

#[derive(Clone)]
struct Shutdown {
    started: tokio::time::Instant,
    input_error: Option<String>,
}

fn start_shutdown(shutdown: &watch::Sender<Option<Shutdown>>, input_error: Option<String>) {
    shutdown.send_if_modified(|state| match state {
        None => {
            *state = Some(Shutdown {
                started: tokio::time::Instant::now(),
                input_error: input_error.clone(),
            });
            true
        }
        Some(state) if state.input_error.is_none() && input_error.is_some() => {
            state.input_error = input_error.clone();
            true
        }
        Some(_) => false,
    });
}

fn shutdown_deadline(stopping: &watch::Receiver<Option<Shutdown>>) -> tokio::time::Instant {
    stopping
        .borrow()
        .as_ref()
        .map(|state| state.started)
        .unwrap_or_else(tokio::time::Instant::now)
        + SHUTDOWN_BUDGET
}

async fn read_requests<R: AsyncBufRead + Unpin>(
    reader: R,
    send: mpsc::Sender<std::io::Result<String>>,
    shutdown: watch::Sender<Option<Shutdown>>,
) {
    let mut lines = reader.lines();
    let input_error = loop {
        match lines.next_line().await {
            Ok(Some(line)) => match send.try_send(Ok(line)) {
                Ok(()) => {}
                // Waiting for queue capacity would prevent this reader from observing
                // EOF behind a long-running launch. Reject overload with a bounded queue.
                Err(mpsc::error::TrySendError::Full(_)) => {
                    break Some(format!("driver stdin request queue exceeded its {INPUT_QUEUE_CAPACITY}-request capacity"));
                }
                Err(mpsc::error::TrySendError::Closed(_)) => break None,
            },
            Ok(None) => break None,
            Err(error) => break Some(format!("failed to read driver stdin: {error}")),
        }
    };
    start_shutdown(&shutdown, input_error);
}

pub async fn run_stdio() -> Result<()> {
    let instances = Arc::new(Mutex::new(HashMap::new()));
    let (shutdown, stopping) = watch::channel(None);
    let (send, input) = mpsc::channel(INPUT_QUEUE_CAPACITY);
    let eof = shutdown.clone();
    // Read independently of request execution: EOF can cancel an installation
    // or launch instead of waiting for the potentially unbounded request.
    tokio::spawn(read_requests(BufReader::new(tokio::io::stdin()), send, eof));
    let signalled = instances.clone();
    tokio::spawn(async move {
        let signal = terminating_signal().await;
        note_signal(&signalled, signal).await;
        start_shutdown(&shutdown, None);
    });
    let served = serve_requests(input, stopping.clone(), instances.clone()).await;
    let deadline = shutdown_deadline(&stopping);
    let cleanup = tokio::time::timeout_at(deadline, launch::shutdown_all(instances.clone())).await;
    let input_error = stopping
        .borrow()
        .as_ref()
        .and_then(|state| state.input_error.clone());
    let torn_down = matches!(cleanup, Ok(Ok(()))) && served.is_ok() && input_error.is_none();
    if let Some(error) = input_error {
        eprintln!("blockwright driver input: {error}");
    }
    if let Err(error) = &served {
        eprintln!("blockwright driver: {error:#}");
    }
    if let Ok(Err(error)) = &cleanup {
        eprintln!("blockwright driver cleanup: {error:#}");
    }
    if !torn_down {
        let held = instances.try_lock().ok().map(|state| state.len());
        eprintln!(
            "blockwright driver: teardown failed or exceeded its {}s total budget, so this driver is exiting \
             {EXIT_CLEANUP_INCOMPLETE} with cleanup incomplete{}. Game processes it had not \
             finished stopping may still be running; each one's pid is still recorded under \
             .blockwright/instances.d",
            SHUTDOWN_BUDGET.as_secs(),
            match held {
                Some(count) => format!(" ({count} instance(s) still held)"),
                None => String::new(),
            }
        );
    }

    if !torn_down {
        std::process::exit(EXIT_CLEANUP_INCOMPLETE);
    }
    // A console signal can leave Tokio's stdin blocking thread parked. Every
    // owned game has been cleaned up before we bypass the runtime's stdin join.
    std::process::exit(0)
}

async fn serve_requests(
    input: mpsc::Receiver<std::io::Result<String>>,
    stopping: watch::Receiver<Option<Shutdown>>,
    instances: SharedInstances,
) -> Result<()> {
    let mut stdout = tokio::io::stdout();
    serve_requests_to(input, stopping, instances, &mut stdout).await
}

async fn serve_requests_to<W: AsyncWrite + Unpin>(
    mut input: mpsc::Receiver<std::io::Result<String>>,
    mut stopping: watch::Receiver<Option<Shutdown>>,
    instances: SharedInstances,
    stdout: &mut W,
) -> Result<()> {
    loop {
        if stopping.borrow().is_some() {
            return Ok(());
        }
        let line = tokio::select! {
            biased;
            _ = stopping.changed() => return Ok(()),
            line = input.recv() => match line { Some(line) => line?, None => return Ok(()) },
        };
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                if !write_response_until_stopping(
                    stdout,
                    json!({
                        "jsonrpc": "2.0",
                        "id": null,
                        "error": { "code": -32700, "message": error.to_string() },
                    }),
                    &mut stopping,
                )
                .await?
                {
                    return Ok(());
                }
                continue;
            }
        };

        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let finishing_close = request["method"] == "lifecycle.close";
        let work = handle_request(request, instances.clone());
        tokio::pin!(work);
        let result = tokio::select! {
            result = &mut work => result,
            _ = stopping.changed() => {
                // Do not cancel an instance already in its normal-save path.
                if finishing_close {
                    let deadline = shutdown_deadline(&stopping);
                    let result = tokio::time::timeout_at(deadline, &mut work).await.context("active instance close exceeded shutdown budget")??;
                    anyhow::ensure!(result["success"] != false, "active instance close was unsuccessful");
                }
                return Ok(());
            }
        };
        let response = match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32000, "message": format!("{error:#}") },
            }),
        };

        if !write_response_until_stopping(stdout, response, &mut stopping).await? {
            return Ok(());
        }
    }
}

async fn note_signal(instances: &SharedInstances, signal: &str) {
    let guard = instances.lock().await;
    for instance in guard.values() {
        let _ = instance.sink.write(
            "driver",
            "lifecycle.signal",
            json!({
                "signal": signal,
                "teardown": "this driver tears down on a signal exactly the way it does when its \
                             stdin closes: every instance it launched is stopped. A death this \
                             driver cannot answer, such as SIGKILL, a panic or an OOM kill, \
                             leaves the game JVMs to notice on their own that their parent is \
                             gone",
            }),
        );
    }
}

#[cfg(unix)]
async fn terminating_signal() -> &'static str {
    use tokio::signal::unix::{signal, Signal, SignalKind};

    async fn next(stream: &mut Option<Signal>) -> Option<()> {
        match stream {
            Some(stream) => stream.recv().await,
            None => std::future::pending().await,
        }
    }

    let mut terminate = signal(SignalKind::terminate()).ok();
    let mut interrupt = signal(SignalKind::interrupt()).ok();
    let mut hangup = signal(SignalKind::hangup()).ok();
    loop {
        tokio::select! {
            received = next(&mut terminate) => {
                if received.is_some() {
                    return "SIGTERM";
                }
                terminate = None;
            }
            received = next(&mut interrupt) => {
                if received.is_some() {
                    return "SIGINT";
                }
                interrupt = None;
            }
            received = next(&mut hangup) => {
                if received.is_some() {
                    return "SIGHUP";
                }
                hangup = None;
            }
        }
    }
}

#[cfg(windows)]
async fn terminating_signal() -> &'static str {
    let mut interrupt = tokio::signal::windows::ctrl_c().ok();
    let mut close = tokio::signal::windows::ctrl_close().ok();
    async fn next(stream: &mut Option<tokio::signal::windows::CtrlC>) {
        match stream {
            Some(stream) => {
                stream.recv().await;
            }
            None => std::future::pending().await,
        }
    }
    tokio::select! {
        _ = next(&mut interrupt) => "CTRL_C",
        _ = async { match close.as_mut() { Some(stream) => { stream.recv().await; }, None => std::future::pending().await } } => "CTRL_CLOSE",
    }
}

async fn handle_request(request: Value, instances: SharedInstances) -> Result<Value> {
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .context("missing JSON-RPC method")?;
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let instances = &instances;

    match method {
        "ping" => Ok(json!({ "pong": true })),
        "game.connect" => call(method, params, instances, connect_game).await,
        "neoforge.launch" => call(method, params, instances, launch::launch_neoforge).await,
        "lifecycle.close" => call(method, params, instances, launch::close_instance).await,
        _ => anyhow::bail!("unknown method: {method}"),
    }
}

/// Decodes `params` for `method`, runs `handler` and encodes its result.
async fn call<P, R, F, Fut>(
    method: &str,
    params: Value,
    instances: &SharedInstances,
    handler: F,
) -> Result<Value>
where
    P: serde::de::DeserializeOwned,
    R: serde::Serialize,
    F: FnOnce(P, SharedInstances) -> Fut,
    Fut: std::future::Future<Output = Result<R>>,
{
    let params: P =
        serde_json::from_value(params).with_context(|| format!("invalid {method} params"))?;
    Ok(serde_json::to_value(
        handler(params, instances.clone()).await?,
    )?)
}

/// Asks the instance's agent for game-channel credentials and returns its answer untouched:
/// `{protocol: "blockwright-game", host, port, token}`.
async fn connect_game(params: InstanceStatusParams, instances: SharedInstances) -> Result<Value> {
    let control = {
        let state = instances.lock().await;
        state
            .get(&params.instance_id)
            .with_context(|| format!("unknown instance: {}", params.instance_id))?
            .control
            .clone()
    };
    control
        .call(&params.instance_id, "game.connect", json!({}))
        .await
        .context("cannot open game transport")
}

async fn write_response_until_stopping<W: AsyncWrite + Unpin>(
    stdout: &mut W,
    response: Value,
    stopping: &mut watch::Receiver<Option<Shutdown>>,
) -> Result<bool> {
    if stopping.borrow().is_some() {
        return Ok(false);
    }
    tokio::select! {
        biased;
        _ = stopping.changed() => Ok(false),
        written = write_response(stdout, response) => written.map(|()| true),
    }
}

async fn write_response<W: AsyncWrite + Unpin>(stdout: &mut W, response: Value) -> Result<()> {
    stdout
        .write_all(serde_json::to_string(&response)?.as_bytes())
        .await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use control::{pump_agent_responses, write_line, AgentControlHandle, ControlMux};
    use std::path::PathBuf;

    #[tokio::test]
    async fn a_full_input_queue_reports_overload_and_starts_shutdown_without_waiting() {
        let (mut client, reader) = tokio::io::duplex(64 * 1024);
        let (send, _input) = mpsc::channel(INPUT_QUEUE_CAPACITY);
        let (shutdown, stopping) = watch::channel(None);
        let task = tokio::spawn(read_requests(BufReader::new(reader), send, shutdown));
        let requests = "{\"id\":1,\"method\":\"ping\"}\n".repeat(INPUT_QUEUE_CAPACITY + 1);
        client.write_all(requests.as_bytes()).await.unwrap();
        client.shutdown().await.unwrap();

        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("the reader waited for queue capacity instead of starting shutdown")
            .unwrap();

        let state = stopping
            .borrow()
            .clone()
            .expect("shutdown was not requested");
        assert!(state
            .input_error
            .as_deref()
            .is_some_and(|error| error.contains("request queue exceeded")));
        assert!(shutdown_deadline(&stopping) > tokio::time::Instant::now());
    }

    #[tokio::test]
    async fn eof_cancels_a_request_already_waiting_for_an_agent_response() {
        let (near, far) = tokio::io::duplex(64 * 1024);
        let (_near_read, near_write) = tokio::io::split(near);
        let (far_read, _far_write) = tokio::io::split(far);
        let mux = ControlMux::connected(Box::new(near_write)).await;
        let instances: SharedInstances = Default::default();
        let mut instance = launch::test_instance(blockwright::config::InstanceRole::Client);
        instance.control = AgentControlHandle::over(mux);
        instances.lock().await.insert("test".to_string(), instance);
        let (mut client, reader) = tokio::io::duplex(64 * 1024);
        let (send, input) = mpsc::channel(INPUT_QUEUE_CAPACITY);
        let (shutdown, stopping) = watch::channel(None);
        let read_task = tokio::spawn(read_requests(BufReader::new(reader), send, shutdown));
        let mut stdout = tokio::io::sink();
        let serve_task = serve_requests_to(input, stopping, instances, &mut stdout);
        let client_task = async move {
            client
            .write_all(
                b"{\"id\":1,\"method\":\"game.connect\",\"params\":{\"instanceId\":\"test\"}}\n",
            )
            .await
            .unwrap();
            let mut agent = BufReader::new(far_read).lines();
            let request = agent.next_line().await.unwrap().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&request).unwrap()["method"],
                "game.connect"
            );
            // The agent deliberately never answers. EOF must cancel the in-flight call.
            client.shutdown().await.unwrap();
        };
        let (served, ()) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(serve_task, client_task)
        })
        .await
        .expect("EOF did not cancel the pending request");
        served.unwrap();
        read_task.await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_interrupts_a_response_when_stdout_is_not_consumed() {
        for request in ["{\"id\":1,\"method\":\"ping\"}", "invalid JSON"] {
            let (send, input) = mpsc::channel(INPUT_QUEUE_CAPACITY);
            let (shutdown, stopping) = watch::channel(None);
            // Holding the reader without consuming it blocks replies after one byte.
            let (_unread, mut stdout) = tokio::io::duplex(1);
            let mut task = Box::pin(serve_requests_to(
                input,
                stopping,
                Default::default(),
                &mut stdout,
            ));
            send.send(Ok(request.to_string())).await.unwrap();
            assert!(tokio::time::timeout(Duration::from_millis(50), &mut task)
                .await
                .is_err());
            start_shutdown(&shutdown, None);

            tokio::time::timeout(Duration::from_secs(1), task)
                .await
                .expect("blocked stdout prevented shutdown")
                .unwrap();
        }
    }

    #[tokio::test]
    async fn input_read_errors_are_retained_in_the_shutdown_result() {
        let (mut client, reader) = tokio::io::duplex(32);
        let (send, _input) = mpsc::channel(INPUT_QUEUE_CAPACITY);
        let (shutdown, stopping) = watch::channel(None);
        let task = tokio::spawn(read_requests(BufReader::new(reader), send, shutdown));
        client.write_all(&[0xff, b'\n']).await.unwrap();

        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();

        let state = stopping.borrow().clone().unwrap();
        assert!(state
            .input_error
            .as_deref()
            .is_some_and(|error| error.contains("failed to read driver stdin")));
    }

    #[tokio::test]
    async fn game_connect_returns_the_agent_answer_untouched() {
        let (near, far) = tokio::io::duplex(64 * 1024);
        let (near_read, near_write) = tokio::io::split(near);
        let (far_read, mut far_write) = tokio::io::split(far);
        let mux = ControlMux::connected(Box::new(near_write)).await;
        tokio::spawn(pump_agent_responses(
            mux.clone(),
            BufReader::new(near_read),
            None,
        ));
        let credentials = json!({
            "protocol": "blockwright-game",
            "host": "127.0.0.1",
            "port": 41234,
            "token": "secret",
        });
        let answer = credentials.clone();
        let agent = tokio::spawn(async move {
            let mut lines = BufReader::new(far_read).lines();
            let request: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            write_line(
                &mut far_write,
                &json!({ "id": request["id"], "result": answer }),
            )
            .await
            .unwrap();
            request
        });

        let instances: SharedInstances = Default::default();
        let mut instance = launch::test_instance_with(launch::test_plan(
            "client",
            PathBuf::from("/nonexistent"),
            Vec::new(),
        ));
        instance.control = AgentControlHandle::over(mux);
        instances
            .lock()
            .await
            .insert("client".to_string(), instance);

        let response = handle_request(
            json!({ "id": 1, "method": "game.connect", "params": { "instanceId": "client" } }),
            instances,
        )
        .await
        .unwrap();

        assert_eq!(response, credentials);
        let request = agent.await.unwrap();
        assert_eq!(request["method"], json!("game.connect"));
        assert_eq!(request["params"]["instanceId"], json!("client"));
    }

    #[tokio::test]
    async fn the_driver_answers_only_lifecycle_methods() {
        let instances: SharedInstances = Default::default();
        assert_eq!(
            handle_request(json!({ "method": "ping" }), instances.clone())
                .await
                .unwrap(),
            json!({ "pong": true })
        );
        for method in [
            "pixels.recording.start",
            "pixels.recording.stop",
            "world.status",
        ] {
            let error =
                handle_request(json!({ "method": method, "params": {} }), instances.clone())
                    .await
                    .unwrap_err();
            assert!(error.to_string().contains("unknown method"), "{method}");
        }
    }
}

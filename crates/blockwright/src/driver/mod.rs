mod control;
mod launch;
pub(crate) mod types;

use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::Mutex,
};

use launch::RunningInstance;
use types::*;

type SharedInstances = Arc<Mutex<HashMap<String, RunningInstance>>>;

const SHUTDOWN_BUDGET: Duration = Duration::from_secs(30);
const EXIT_CLEANUP_INCOMPLETE: i32 = 75;

pub async fn run_stdio() -> Result<()> {
    let instances = Arc::new(Mutex::new(HashMap::new()));

    let served = tokio::select! {
        result = serve_requests(instances.clone()) => Some(result),
        signal = terminating_signal() => {
            note_signal(&instances, signal).await;
            None
        }
    };

    let torn_down = tokio::time::timeout(SHUTDOWN_BUDGET, launch::shutdown_all(instances.clone()))
        .await
        .is_ok();
    if !torn_down {
        let held = instances.try_lock().ok().map(|state| state.len());
        eprintln!(
            "blockwright driver: teardown did not finish within {}s, so this driver is exiting \
             {EXIT_CLEANUP_INCOMPLETE} with cleanup incomplete{}. Game processes it had not \
             finished stopping may still be running; each one's pid is still recorded under \
             .blockwright/instances.d, and killing that pid's process group stops it",
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
    match served {
        Some(result) => result,
        // A signal left the stdin reader parked on its blocking thread, which the runtime would
        // wait for on shutdown while the SDK still holds the pipe open; exit instead of returning.
        None => std::process::exit(0),
    }
}

async fn serve_requests(instances: SharedInstances) -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut lines = BufReader::new(stdin).lines();

    while let Some(line) = lines.next_line().await? {
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                write_response(
                    &mut stdout,
                    json!({
                        "jsonrpc": "2.0",
                        "id": null,
                        "error": { "code": -32700, "message": error.to_string() },
                    }),
                )
                .await?;
                continue;
            }
        };

        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let response = match handle_request(request, instances.clone()).await {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32000, "message": format!("{error:#}") },
            }),
        };

        write_response(&mut stdout, response).await?;
    }
    Ok(())
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

async fn write_response(stdout: &mut tokio::io::Stdout, response: Value) -> Result<()> {
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

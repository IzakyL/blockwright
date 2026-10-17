use std::{path::Path, sync::OnceLock, time::Duration};

use anyhow::{Context, Result};
use reqwest::{Client, StatusCode};
use tokio::fs as tokio_fs;

const USER_AGENT: &str = concat!("Blockwright/", env!("CARGO_PKG_VERSION"));
/// A connection that sends nothing for this long is dropped and retried, so one stalled
/// socket among thousands of asset downloads cannot hang a launch. It bounds each read, not
/// the whole transfer, so large downloads still finish.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const ATTEMPTS: u32 = 4;

/// One HTTP client for the whole process, so launches reuse pooled connections.
pub(crate) fn http_client() -> Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .user_agent(USER_AGENT)
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(READ_TIMEOUT)
                .build()
                .unwrap_or_else(|_| Client::new())
        })
        .clone()
}

pub(crate) async fn get_bytes(url: &str) -> Result<Vec<u8>> {
    let mut attempt = 1;
    loop {
        let result =
            async { Ok::<_, reqwest::Error>(get(url).await?.bytes().await?.to_vec()) }.await;
        match result {
            Err(error) if attempt < ATTEMPTS && transient(&error) => {
                tokio::time::sleep(Duration::from_millis(500 << attempt)).await;
                attempt += 1;
            }
            result => {
                return result.with_context(|| {
                    format!("failed to download {url} (attempt {attempt} of {ATTEMPTS})")
                })
            }
        }
    }
}

fn transient(error: &reqwest::Error) -> bool {
    error.is_timeout()
        || error.is_connect()
        || error.is_body()
        || error.is_request()
        || error
            .status()
            .is_some_and(|status| status.is_server_error())
}

/// Downloads `url` into `dest` through a temp file beside it.
pub(crate) async fn download(url: &str, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        tokio_fs::create_dir_all(parent)
            .await
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let bytes = get_bytes(url).await?;
    let dest = dest.to_path_buf();
    crate::engine::blocking(move || crate::store::cache::write_replacing(&dest, bytes)).await
}

/// GETs `url`, waiting out one rate-limit response, and fails on an error status.
async fn get(url: &str) -> reqwest::Result<reqwest::Response> {
    let client = http_client();
    let mut response = client.get(url).send().await?;
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        let wait = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .map(Duration::from_secs)
            .unwrap_or_else(|| Duration::from_secs(2));
        tokio::time::sleep(wait.min(Duration::from_secs(10))).await;
        response = client.get(url).send().await?;
    }
    response.error_for_status()
}

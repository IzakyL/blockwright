use std::path::PathBuf;

use blockwright::{config::InstanceRole, engine::LaunchPlan};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstanceLaunchParams {
    #[serde(default)]
    pub(crate) config: Option<PathBuf>,
    pub(crate) role: InstanceRole,
    #[serde(default)]
    pub(crate) instance: Option<String>,
    #[serde(default)]
    pub(crate) trace: Option<String>,
    #[serde(default)]
    pub(crate) agent_mod: Option<PathBuf>,
    #[serde(default)]
    pub(crate) reuse_instance_dir: bool,
    #[serde(default)]
    pub(crate) keep_instance_dir: bool,
    #[serde(default)]
    pub(crate) start_frozen: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstanceStatusParams {
    pub(crate) instance_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstanceCloseParams {
    pub(crate) instance_id: String,
    #[serde(default)]
    pub(crate) keep_projection: bool,
    /// How long the game gets after SIGTERM before SIGKILL; default 10 s.
    #[serde(default)]
    pub(crate) grace_ms: Option<u64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstanceLaunchResult {
    pub(crate) instance_id: String,
    pub(crate) role: InstanceRole,
    pub(crate) trace_path: PathBuf,
    pub(crate) instance_dir: PathBuf,
    pub(crate) resolved: Value,
    pub(crate) requirements: Value,
    pub(crate) warnings: Vec<String>,
}

impl InstanceLaunchResult {
    pub(crate) fn from_neoforge_plan(plan: &LaunchPlan) -> Self {
        Self {
            instance_id: plan.instance_id.clone(),
            role: plan.role,
            trace_path: plan.trace_path.clone(),
            instance_dir: plan.instance_dir.clone(),
            resolved: serde_json::to_value(&plan.resolved).unwrap_or(Value::Null),
            requirements: serde_json::to_value(&plan.requirements).unwrap_or(Value::Null),
            warnings: plan.warnings.clone(),
        }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstanceCloseResult {
    /// The exit code; null when a signal ended the process or there was none.
    pub(crate) code: Option<i32>,
    /// The signal that ended the process, when one did.
    pub(crate) signal: Option<i32>,
    /// Exited on its own: its status succeeded. Stopped by the driver: it went on SIGTERM without
    /// leaving crash evidence.
    pub(crate) success: bool,
    /// The driver stopped the process; false when it had already exited on its own.
    pub(crate) terminated: bool,
    /// It ignored SIGTERM for the whole grace period and was SIGKILLed.
    pub(crate) killed: bool,
    /// `crashReport`, `crashSummary`, `jvmCrashLog` and `jvmCrashSummary` when the game left a
    /// crash report or JVM fatal-error log behind during this run; absent otherwise.
    #[serde(flatten)]
    pub(crate) crash: serde_json::Map<String, Value>,
}

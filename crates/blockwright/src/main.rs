mod common;
mod driver;

use std::path::PathBuf;

use anyhow::Result;
use blockwright::config::{load_config, load_config_profiles};
use clap::{Args, Parser, Subcommand};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "blockwright", version)]
#[command(about = "Automation driver for game instances")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    #[command(about = "Run the hidden JSON-RPC stdio driver used by SDKs")]
    Driver,
    #[command(
        about = "Drop store entries no config uses any more, and instance dirs and traces no \
                 running instance owns"
    )]
    Gc(GcArgs),
    #[command(about = "Fetch the jars declared under [mods] into the store")]
    Mods {
        #[command(subcommand)]
        command: ModsCommand,
    },
    #[command(about = "Report or clear the code coverage recorded with [coverage]")]
    Coverage {
        #[command(subcommand)]
        command: CoverageCommand,
    },
}

#[derive(Debug, Subcommand)]
enum CoverageCommand {
    #[command(
        about = "Merge the coverage every instance recorded into HTML, XML and LCOV reports"
    )]
    Report(CoverageReportArgs),
    #[command(about = "Delete the recorded coverage and the default report")]
    Reset(CoverageResetArgs),
}

#[derive(Debug, Args)]
struct CoverageReportArgs {
    #[arg(long, default_value = "blockwright.toml")]
    config: PathBuf,
    #[arg(long, help = "Where the reports go; <coverage.dir>/report by default")]
    out: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct CoverageResetArgs {
    #[arg(long, default_value = "blockwright.toml")]
    config: PathBuf,
}

#[derive(Debug, Subcommand)]
enum ModsCommand {
    #[command(
        about = "Fetch every mod that is not a local path into the store and write \
                 .blockwright/mods.json, which maps each mod name to its jars"
    )]
    Sync(ModsSyncArgs),
}

#[derive(Debug, Args)]
struct ModsSyncArgs {
    #[arg(long, default_value = "blockwright.toml")]
    config: PathBuf,
}

#[derive(Debug, Args)]
struct GcArgs {
    #[arg(long, default_value = "blockwright.toml")]
    config: PathBuf,
    #[arg(long, help = "List what would go without deleting it")]
    dry_run: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_target(false)
        .compact()
        .init();

    let cli = Cli::parse();
    match cli.command {
        Commands::Driver => driver::run_stdio().await,
        Commands::Gc(args) => run_gc_command(args),
        Commands::Mods { command } => match command {
            ModsCommand::Sync(args) => sync_mods(args).await,
        },
        Commands::Coverage { command } => match command {
            CoverageCommand::Report(args) => coverage_report(args).await,
            CoverageCommand::Reset(args) => coverage_reset(args),
        },
    }
}

async fn sync_mods(args: ModsSyncArgs) -> Result<()> {
    let report = blockwright::mods::sync(&load_config_profiles(&args.config)?).await?;
    for (name, paths) in &report.mods {
        for path in paths {
            println!("{name}: {}", path.display());
        }
    }
    println!(
        "mods: {} synced into {}",
        report.mods.len(),
        report.manifest.display()
    );
    Ok(())
}

async fn coverage_report(args: CoverageReportArgs) -> Result<()> {
    let loaded = load_config(&args.config)?;
    let out = blockwright::coverage::report(&loaded, args.out).await?;
    println!("coverage: reports in {}", out.display());
    Ok(())
}

fn coverage_reset(args: CoverageResetArgs) -> Result<()> {
    let loaded = load_config(&args.config)?;
    let removed = blockwright::coverage::reset(&loaded, &std::env::current_dir()?)?;
    for path in &removed {
        println!("removed {}", path.display());
    }
    if removed.is_empty() {
        println!("coverage: nothing recorded");
    }
    Ok(())
}

fn run_gc_command(args: GcArgs) -> Result<()> {
    use blockwright::store::gc::{gc, GcScope};

    let loaded = load_config(&args.config)?;
    let (store_dir, cwd) = (loaded.store_dir(), std::env::current_dir()?);
    let scope = GcScope {
        store_dir: &store_dir,
        instances_dir: &loaded.resolve_path(&loaded.config.neoforge.instances_dir),
        traces_dir: &loaded.resolve_path(&loaded.config.trace.dir),
        registry_root: &cwd,
    };
    let Some(report) = gc(&scope, args.dry_run)? else {
        anyhow::bail!(
            "a launch or sync is using {}; try again once it is done",
            store_dir.display()
        );
    };
    for path in &report.removed {
        println!(
            "{}{}",
            if args.dry_run {
                "would remove "
            } else {
                "removed "
            },
            path.display()
        );
    }
    println!(
        "gc: {} entries, {} bytes",
        report.removed.len(),
        report.bytes
    );
    Ok(())
}

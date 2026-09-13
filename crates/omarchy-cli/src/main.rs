mod api;
mod cli;
mod config;
mod mcp;
mod state;

use anyhow::Result;
use clap::Parser;

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let args = cli::Cli::parse();
    let code = cli::run(args)?;
    std::process::exit(code);
}

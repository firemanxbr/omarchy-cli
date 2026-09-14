//! `omarchy-cli mcp`: the client as an MCP server, so an assistant on the
//! machine can ask what the ring serves, what is installed from it, what an
//! out-of-band install would do and whether it is safe, and which installed
//! packages carry an open advisory — the same answers `--json` gives, as
//! tools. Read-only: nothing here installs, upgrades or pins. Stdio
//! transport, one JSON-RPC 2.0 message per line, no dependencies beyond
//! `serde_json`.

use std::io::{BufRead, Write};

use anyhow::Result;
use serde_json::{json, Value};

use crate::api::Api;
use crate::cli;
use crate::config::Config;

const PROTOCOL: &str = "2025-06-18";

/// The tools, with the input each takes (JSON Schema, as MCP wants it).
fn tools() -> Value {
    json!([
        { "name": "status", "description": "The ring this machine follows, the pinned release, what the ring serves now and the pending updates.",
          "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false } },
        { "name": "check", "description": "Whether installing packages out of band is safe here: the plan (install/upgrade), ABI findings against this system's libraries (blockers = symbol versions it cannot satisfy) and the libalpm hooks pacman would run. Read-only.",
          "inputSchema": { "type": "object", "properties": { "targets": { "type": "array", "items": { "type": "string" }, "minItems": 1, "description": "Package names as the ring serves them." } }, "required": ["targets"], "additionalProperties": false } },
        { "name": "info", "description": "A package as the ring's release publishes it: version, description, dependencies, provides, ABI needs, embedded libraries, size, checksum, mirror URL, and its seal (where the object came from — the factory chain with audit, approval and attestation, or the upstream project and keyring).",
          "inputSchema": { "type": "object", "properties": { "package": { "type": "string" } }, "required": ["package"], "additionalProperties": false } },
        { "name": "search", "description": "Packages in the ring's release whose name or description contains the query.",
          "inputSchema": { "type": "object", "properties": { "query": { "type": "string", "minLength": 2 } }, "required": ["query"], "additionalProperties": false } },
        { "name": "list", "description": "Installed packages the ring's release also serves, each current, update (the ring is newer) or ahead (the machine is newer).",
          "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false } },
        { "name": "security", "description": "Installed packages with an open advisory in the ring's report (severity, CVEs, exploited in the wild, EPSS) and whether an upgrade from the ring fixes each.",
          "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false } },
    ])
}

fn call(config: &Config, api: &Api, name: &str, args: &Value) -> Result<Value> {
    let strings = |k: &str| -> Vec<String> {
        args.get(k)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let string = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    match name {
        "status" => cli::status_value(config, api),
        "check" => {
            let targets = strings("targets");
            anyhow::ensure!(!targets.is_empty(), "check needs targets");
            cli::check_value(config, api, &targets)
        }
        "info" => {
            let p = string("package");
            anyhow::ensure!(!p.is_empty(), "info needs a package");
            cli::info_value(config, api, &p)
        }
        "search" => {
            let q = string("query");
            anyhow::ensure!(
                q.chars().count() >= 2,
                "search needs a query of at least two characters"
            );
            cli::search_value(config, api, &q)
        }
        "list" => cli::list_value(config, api),
        "security" => cli::security_value(config, api),
        other => anyhow::bail!("unknown tool {other}"),
    }
}

/// One request → one response (`None` for notifications).
fn handle(config: &Config, api: &Api, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let reply = |result: Value| Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    let error = |code: i64, message: String| {
        Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }))
    };
    match method {
        "initialize" => reply(json!({
            "protocolVersion": PROTOCOL,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "omarchy-cli", "version": pkg_manifest::BUILD_VERSION },
            "instructions": format!("The Omarchy pool client on this machine: ring {}, {}. Every tool is read-only; installing and upgrading stay with the person at the keyboard (`omarchy-cli install`, `omarchy-cli upgrade`).", config.ring, config.api),
        })),
        // Notifications: nothing to answer.
        m if m.starts_with("notifications/") => None,
        "ping" => reply(json!({})),
        "tools/list" => reply(json!({ "tools": tools() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match call(config, api, name, &args) {
                Ok(v) => reply(json!({
                    "content": [{ "type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default() }],
                    "structuredContent": v,
                    "isError": false,
                })),
                Err(e) => reply(json!({
                    "content": [{ "type": "text", "text": format!("{e:#}") }],
                    "isError": true,
                })),
            }
        }
        _ if id.is_none() => None,
        other => error(-32601, format!("method not found: {other}")),
    }
}

/// Serves until stdin closes.
pub fn serve(config: &Config, api: &Api) -> Result<i32> {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                writeln!(
                    out,
                    "{}",
                    json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("parse error: {e}") } })
                )?;
                out.flush()?;
                continue;
            }
        };
        if let Some(reply) = handle(config, api, &msg) {
            writeln!(out, "{reply}")?;
            out.flush()?;
        }
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Config, Api) {
        let config = Config::default();
        let api = Api::new("http://127.0.0.1:1").unwrap();
        (config, api)
    }

    #[test]
    fn initialize_lists_tools_and_answers_ping() {
        let (config, api) = setup();
        let init = handle(&config, &api, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "0" } } })).unwrap();
        assert_eq!(init["result"]["protocolVersion"], PROTOCOL);
        assert_eq!(init["result"]["serverInfo"]["name"], "omarchy-cli");
        assert!(handle(
            &config,
            &api,
            &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
        )
        .is_none());
        assert_eq!(
            handle(
                &config,
                &api,
                &json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" })
            )
            .unwrap()["result"],
            json!({})
        );
        let list = handle(
            &config,
            &api,
            &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }),
        )
        .unwrap();
        let names: Vec<&str> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            vec!["status", "check", "info", "search", "list", "security"]
        );
        let unknown = handle(
            &config,
            &api,
            &json!({ "jsonrpc": "2.0", "id": 4, "method": "nope" }),
        )
        .unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[test]
    fn a_tool_error_is_a_result_with_is_error_not_a_protocol_error() {
        let (config, api) = setup();
        // Bad arguments never reach the network.
        let r = handle(&config, &api, &json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "check", "arguments": {} } })).unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("targets"));
        let r = handle(&config, &api, &json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": { "name": "search", "arguments": { "query": "x" } } })).unwrap();
        assert_eq!(r["result"]["isError"], true);
        let r = handle(&config, &api, &json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "nope", "arguments": {} } })).unwrap();
        assert!(r["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("unknown tool"));
        // A tool that needs the pool, against a closed port: an error result, the server keeps going.
        let r = handle(&config, &api, &json!({ "jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": { "name": "status", "arguments": {} } })).unwrap();
        assert_eq!(r["result"]["isError"], true);
    }
}

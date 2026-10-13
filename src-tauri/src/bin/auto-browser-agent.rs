use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

#[derive(Deserialize)]
struct Connection {
    endpoint: String,
    token: String,
}
fn connection() -> Result<Connection, String> {
    let path = std::env::var_os("AUTO_BROWSER_CONNECTION")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            dirs::data_dir()
                .unwrap_or_default()
                .join("dev.autobrowser.app/agent.json")
        });
    let bytes = std::fs::read(&path)
        .map_err(|_| format!("请先启动 Auto Browser。找不到接入文件：{}", path.display()))?;
    let c: Connection = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let url = reqwest::Url::parse(&c.endpoint).map_err(|e| e.to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return Err("接入地址必须是本机 IPv4 回环地址".into());
    }
    Ok(c)
}
async fn http_request(path: &str, body: Option<Value>) -> Result<Value, String> {
    let c = connection()?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}{path}", c.endpoint);
    let builder = if let Some(body) = body {
        client.post(url).json(&body)
    } else {
        client.get(url)
    };
    let response = builder
        .bearer_auth(c.token)
        .send()
        .await
        .map_err(|e| format!("无法连接桌面应用：{e}"))?;
    response
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}
fn rpc_error(id: Value, code: i32, message: String) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
async fn mcp() -> Result<(), String> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut initialized = false;
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                writeln!(stdout, "{}", rpc_error(Value::Null, -32700, e.to_string()))
                    .map_err(|e| e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;
                continue;
            }
        };
        let Some(id) = request.get("id").cloned() else {
            continue;
        };
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let response = if request.get("jsonrpc") != Some(&json!("2.0")) {
            rpc_error(id, -32600, "Invalid Request".into())
        } else if method == "initialize" {
            initialized = true;
            let requested = request["params"]["protocolVersion"].as_str().unwrap_or("");
            let version =
                if ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].contains(&requested) {
                    requested
                } else {
                    "2025-11-25"
                };
            json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":version,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"auto-browser","version":env!("CARGO_PKG_VERSION")},"instructions":"Operate only app-owned webviews. Query app_status for supported capabilities. Actions are DOM events. Verify the page result before claiming success."}})
        } else if method == "ping" {
            json!({"jsonrpc":"2.0","id":id,"result":{}})
        } else if !initialized {
            rpc_error(id, -32002, "Initialize the server first".into())
        } else {
            match method {
                "tools/list" => match http_request("/tools", None).await {
                    Ok(v) => json!({"jsonrpc":"2.0","id":id,"result":v}),
                    Err(e) => rpc_error(id, -32603, e),
                },
                "tools/call" => {
                    if request["params"]["name"].as_str().is_none() {
                        rpc_error(id, -32602, "Tool name is required".into())
                    } else {
                        let body = json!({"name":request["params"]["name"],"arguments":request["params"].get("arguments").cloned().unwrap_or(json!({}))});
                        let result = match http_request("/call", Some(body)).await {
                            Ok(v) => v,
                            Err(e) => json!({"ok":false,"error":e}),
                        };
                        let ok = result["ok"] == true;
                        let payload = if ok {
                            result["result"].clone()
                        } else {
                            json!({"error":result["error"]})
                        };
                        json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":payload.to_string()}],"structuredContent":payload,"isError":!ok}})
                    }
                }
                _ => rpc_error(id, -32601, format!("Method not found: {method}")),
            }
        };
        writeln!(stdout, "{response}").map_err(|e| e.to_string())?;
        stdout.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("mcp") => mcp().await,
        Some("tools") => http_request("/tools", None)
            .await
            .map(|v| println!("{}", serde_json::to_string_pretty(&v).unwrap())),
        Some("status") => http_request("/call", Some(json!({"name":"app_status","arguments":{}})))
            .await
            .and_then(print_result),
        Some("call") if args.len() >= 2 => {
            match serde_json::from_str::<Value>(args.get(2).map(String::as_str).unwrap_or("{}")) {
                Ok(arguments) => {
                    http_request("/call", Some(json!({"name":args[1],"arguments":arguments})))
                        .await
                        .and_then(print_result)
                }
                Err(e) => Err(format!("JSON 参数错误：{e}")),
            }
        }
        _ => {
            println!(
                "auto-browser-agent mcp | status | tools | call <tool_name> '<JSON arguments>'"
            );
            Ok(())
        }
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
fn print_result(v: Value) -> Result<(), String> {
    if v["ok"] != true {
        return Err(v["error"].as_str().unwrap_or("调用失败").into());
    }
    println!("{}", serde_json::to_string_pretty(&v["result"]).unwrap());
    Ok(())
}

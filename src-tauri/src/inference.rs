use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use futures_util::future::{AbortHandle, Abortable};
use serde_json::{json, Value};
use tauri::State;

use super::validate_local_endpoint;

#[derive(Default)]
pub(crate) struct InferenceManager {
    active: Arc<Mutex<HashMap<String, AbortHandle>>>,
}

struct RequestGuard {
    id: String,
    active: Arc<Mutex<HashMap<String, AbortHandle>>>,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(&self.id);
        }
    }
}

impl InferenceManager {
    pub(crate) async fn run<T>(
        &self,
        request_id: Option<String>,
        future: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let (handle, registration) = AbortHandle::new_pair();
        {
            let mut active = self
                .active
                .lock()
                .map_err(|_| "Local AI request lock failed")?;
            if active.contains_key(&id) {
                return Err("This local AI request is already running.".into());
            }
            active.insert(id.clone(), handle);
        }
        let _guard = RequestGuard {
            id,
            active: self.active.clone(),
        };
        Abortable::new(future, registration)
            .await
            .map_err(|_| "Local AI request cancelled.".to_string())?
    }

    pub(crate) fn cancel(&self, request_id: &str) -> Result<bool, String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Local AI request lock failed")?;
        if let Some(handle) = active.get(request_id) {
            handle.abort();
            return Ok(true);
        }
        Ok(false)
    }
}

#[tauri::command]
pub(crate) fn cancel_local_ai_request(
    state: State<'_, InferenceManager>,
    request_id: String,
) -> Result<bool, String> {
    state.cancel(&request_id)
}

#[derive(Clone, Copy)]
pub(crate) enum Task {
    Filing,
    Answer,
    Brief,
}

impl Task {
    fn output_tokens(self) -> u32 {
        match self {
            Self::Filing => 384,
            Self::Answer => 512,
            Self::Brief => 1536,
        }
    }
    fn timeout(self) -> Duration {
        Duration::from_secs(match self {
            Self::Filing => 35,
            Self::Answer => 45,
            Self::Brief => 120,
        })
    }
}

fn request_body(model: &str, system: &str, prompt: &str, task: Task, structured: bool) -> Value {
    let mut body = json!({
        "model": model,
        "messages": [{"role":"system","content":system},{"role":"user","content":prompt}],
        "temperature": 0.1,
        "max_tokens": task.output_tokens(),
        "chat_template_kwargs": {"enable_thinking": false},
        "stream": false
    });
    if structured {
        body["response_format"] = json!({"type":"json_object"});
    }
    body
}

pub(crate) async fn complete(
    endpoint: &str,
    model: &str,
    system: &str,
    prompt: &str,
    task: Task,
    structured: bool,
) -> Result<String, String> {
    complete_inner(endpoint, model, system, prompt, task, structured, None).await
}

pub(crate) async fn complete_with_schema(
    endpoint: &str, model: &str, system: &str, prompt: &str, task: Task, schema: Value,
) -> Result<String, String> {
    complete_inner(endpoint, model, system, prompt, task, true, Some(schema)).await
}

async fn complete_inner(
    endpoint: &str, model: &str, system: &str, prompt: &str, task: Task, structured: bool, schema: Option<Value>,
) -> Result<String, String> {
    let mut url = validate_local_endpoint(endpoint)?;
    let base = url.path().trim_end_matches('/').to_owned();
    url.set_path(&format!("{base}/chat/completions"));
    url.set_query(None);
    url.set_fragment(None);
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let mut body = request_body(model, system, prompt, task, structured);
    if let Some(schema) = schema {
        body["response_format"] = json!({"type":"json_schema","json_schema":{"name":"enhanced_notes","strict":true,"schema":schema}});
    }
    let response = CLIENT
        .get_or_init(reqwest::Client::new)
        .post(url)
        .timeout(task.timeout())
        .json(&body)
        .send()
        .await
        .map_err(request_error)?;
    if !response.status().is_success() {
        return Err(format!("Local model returned {}", response.status()));
    }
    let json: Value = response.json().await.map_err(request_error)?;
    if json["choices"][0]["finish_reason"] == "length" {
        return Err("The response reached its length limit. Try a shorter question or a smaller transcript section.".into());
    }
    json["choices"][0]["message"]["content"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "Local model returned an empty or unexpected response.".into())
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Local AI took too long. Your notes are safe; retry when the Mac is less busy.".into()
    } else {
        format!("Local model unavailable: {error}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routine_requests_disable_thinking_and_have_task_budgets() {
        for (task, limit) in [
            (Task::Filing, 384),
            (Task::Answer, 512),
            (Task::Brief, 1536),
        ] {
            let body = request_body("local", "system", "evidence", task, true);
            assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
            assert_eq!(body["max_tokens"], limit);
            assert_eq!(body["response_format"]["type"], "json_object");
        }
        assert!(
            request_body("local", "system", "evidence", Task::Answer, false)
                .get("response_format")
                .is_none()
        );
    }

    #[test]
    fn cancelling_one_request_does_not_cancel_another_and_cleans_up() {
        tauri::async_runtime::block_on(async {
            let manager = InferenceManager::default();
            let (cancelled, completed) = futures_util::join!(
                manager.run(Some("cancelled".into()), async {
                    assert!(manager.cancel("cancelled").unwrap());
                    std::future::pending::<Result<i32, String>>().await
                }),
                manager.run(Some("completed".into()), async { Ok(7) }),
            );
            assert!(cancelled.unwrap_err().contains("cancelled"));
            assert_eq!(completed.unwrap(), 7);
            assert!(manager.active.lock().unwrap().is_empty());
            assert!(!manager.cancel("completed").unwrap());
        });
    }
}

use super::answer_stream::{AnswerCancellation, AnswerStream};
use futures::{Stream, StreamExt};
use std::time::Duration;
// A heartbeat/reasoning delta is not answer content and cannot extend the
// first-content deadline. Only actual decoded answer tokens reset idle time.
pub async fn pump<S, B, E, F>(
    stream: &mut S,
    ollama: bool,
    flag: &AnswerCancellation,
    first: tokio::time::Instant,
    idle: Duration,
    mut emit: F,
) -> (Result<(), String>, AnswerStream)
where
    S: Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
    F: FnMut(String),
{
    let mut decoder = AnswerStream::new(ollama);
    let mut received = false;
    let mut deadline = first;
    let mut leading = String::new();
    let result=async{
  loop{
   let chunk=tokio::select!{biased;_=flag.wait()=>return Ok(()),chunk=tokio::time::timeout_at(deadline,stream.next())=>chunk.map_err(|_|if received{"回答正文长时间停更"}else{"服务已连接，但迟迟没有返回回答正文"})?};
   let Some(chunk)=chunk else{break};
   for token in decoder.push(chunk.map_err(|e|e.to_string())?.as_ref()){
    if !received{leading.push_str(&token);if leading.trim().is_empty(){continue;}received=true;emit(std::mem::take(&mut leading));}else{emit(token);}
    deadline=tokio::time::Instant::now()+idle;
   }
   if decoder.is_finished(){break;}
  }
  if flag.is_cancelled(){return Ok(());}
  if !decoder.is_finished(){for token in decoder.flush(){if !received{leading.push_str(&token);if leading.trim().is_empty(){continue;}received=true;emit(std::mem::take(&mut leading));}else{emit(token);}}}
  decoder.outcome()?;if !received{return Err("模型完成响应，但没有可用的回答正文".into());}Ok(())
 }.await;
    (result, decoder)
}
#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream;
    fn frame(text: &str, end: &str) -> Vec<u8> {
        format!("data: {}\n\n",serde_json::json!({"choices":[{"delta":{"content":text},"finish_reason":if end.is_empty(){serde_json::Value::Null}else{serde_json::json!(end)}}]})).into_bytes()
    }
    #[tokio::test]
    async fn empty_completed_responses_are_failures_and_full_code_is_preserved() {
        for (text, valid) in [
            ("", false),
            ("```python\ndef solve(x):\n    return x\n```", true),
        ] {
            let mut s = stream::iter([Ok::<_, String>(frame(text, "stop"))]);
            let mut shown = String::new();
            let (r, _) = pump(
                &mut s,
                false,
                &AnswerCancellation::default(),
                tokio::time::Instant::now() + Duration::from_secs(1),
                Duration::from_secs(1),
                |t| shown.push_str(&t),
            )
            .await;
            assert_eq!(r.is_ok(), valid);
            assert_eq!(shown, text);
        }
    }
    #[tokio::test]
    async fn busy_heartbeats_do_not_satisfy_first_content_deadline() {
        let mut s = Box::pin(stream::unfold((), |_| async {
            tokio::time::sleep(Duration::from_millis(2)).await;
            Some((Ok::<_, String>(b": keepalive\n\n".to_vec()), ()))
        }));
        let (r, _) = pump(
            &mut s,
            false,
            &AnswerCancellation::default(),
            tokio::time::Instant::now() + Duration::from_millis(20),
            Duration::from_secs(1),
            |_| panic!("heartbeat is not content"),
        )
        .await;
        assert!(r.unwrap_err().contains("正文"));
    }
    #[tokio::test]
    async fn cancellation_stops_without_retry_error() {
        let flag = AnswerCancellation::default();
        flag.cancel();
        let mut s = stream::pending::<Result<Vec<u8>, String>>();
        let (r, _) = pump(
            &mut s,
            false,
            &flag,
            tokio::time::Instant::now() + Duration::from_secs(1),
            Duration::from_secs(1),
            |_| panic!(),
        )
        .await;
        assert!(r.is_ok());
    }
    #[tokio::test]
    async fn stalled_partial_content_is_an_error() {
        let mut s = Box::pin(
            stream::iter([Ok::<_, String>(frame("partial code", ""))]).chain(stream::pending()),
        );
        let (r, _) = pump(
            &mut s,
            false,
            &AnswerCancellation::default(),
            tokio::time::Instant::now() + Duration::from_secs(1),
            Duration::from_millis(20),
            |_| {},
        )
        .await;
        assert!(r.unwrap_err().contains("停更"));
    }
}

//! Reuse transport only. Credentials, bodies and per-request deadlines never
//! belong to this cache; decision and answer requests share a connection pool.
use std::{collections::HashMap,hash::{Hash,Hasher},sync::{Mutex,OnceLock},time::{Duration,Instant}};

#[derive(Clone)]
pub(super) struct ModelClient {http:reqwest::Client,timeout:Duration}
impl ModelClient {
    pub fn get(&self,url:impl reqwest::IntoUrl)->reqwest::RequestBuilder {self.http.get(url).timeout(self.timeout)}
    pub fn post(&self,url:impl reqwest::IntoUrl)->reqwest::RequestBuilder {self.http.post(url).timeout(self.timeout)}
}
struct Cached {http:reqwest::Client,created:Instant}
type Key=(String,u64);
fn pools()->&'static Mutex<HashMap<Key,Cached>> {
    static POOLS:OnceLock<Mutex<HashMap<Key,Cached>>>=OnceLock::new();
    POOLS.get_or_init(||Mutex::new(HashMap::new()))
}
fn key(base:&str)->Result<(Key,bool),String>{
    let url=reqwest::Url::parse(base).map_err(|e|e.to_string())?;
    let local=matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"::1"));
    let mut proxy=std::collections::hash_map::DefaultHasher::new();
    for name in ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy"] {
        std::env::var_os(name).hash(&mut proxy);
    }
    Ok(((url.origin().ascii_serialization(),proxy.finish()),local))
}
pub(super) fn client(base:&str,timeout_secs:u64)->Result<ModelClient,String>{
    let(key,local)=key(base)?;
    let mut cache=pools().lock().map_err(|e|e.to_string())?;
    // Refresh infrequently for system proxy changes without keeping an
    // unbounded set of old endpoints alive. Manual connection tests reset it.
    cache.retain(|_,entry|entry.created.elapsed()<Duration::from_secs(300));
    if !cache.contains_key(&key){
        let mut builder=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
        if local {builder=builder.no_proxy();}
        let http=builder.build().map_err(|e|e.to_string())?;
        if cache.len()>=16 {cache.clear();}
        cache.insert(key.clone(),Cached{http,created:Instant::now()});
    }
    Ok(ModelClient{http:cache[&key].http.clone(),timeout:Duration::from_secs(timeout_secs)})
}
pub(super) fn reset(base:&str)->Result<(),String>{
    let(key,_)=key(base)?;
    pools().lock().map_err(|e|e.to_string())?.remove(&key);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener};
    #[tokio::test]
    async fn stages_reuse_one_connection_with_identical_bodies_and_isolated_auth(){
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base=format!("http://{}",listener.local_addr().unwrap());
        let server=tokio::spawn(async move{
            let(mut socket,_)=listener.accept().await.unwrap();let mut captured=Vec::new();
            for _ in 0..3 {
                let mut bytes=Vec::new();
                loop {
                    let mut b=[0u8;1];assert_eq!(socket.read(&mut b).await.unwrap(),1);bytes.push(b[0]);
                    if bytes.ends_with(b"\r\n\r\n"){break;}
                }
                let headers=String::from_utf8(bytes).unwrap();
                let len=headers.lines().find_map(|line|line.to_ascii_lowercase().strip_prefix("content-length:").map(|n|n.trim().parse::<usize>().unwrap())).unwrap();
                let mut body=vec![0;len];socket.read_exact(&mut body).await.unwrap();captured.push((headers,body));
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}").await.unwrap();
            }
            captured
        });
        let payload=serde_json::json!({"model":"same-model","messages":[{"role":"user","content":"Same full input, \\(QK^T\\) and code"}],"temperature":0.2,"max_tokens":6144,"stream":true});
        for (seconds,key) in [(25,Some("decision-key")),(180,Some("answer-key")),(5,None)] {
            let mut request=client(&base,seconds).unwrap().post(format!("{base}/chat/completions")).json(&payload);
            if let Some(key)=key {request=request.bearer_auth(key);}
            assert_eq!(request.try_clone().unwrap().build().unwrap().timeout(),Some(&Duration::from_secs(seconds)));
            tokio::time::timeout(Duration::from_secs(5),async{request.send().await.unwrap().bytes().await.unwrap()}).await.unwrap();
        }
        let captured=tokio::time::timeout(Duration::from_secs(5),server).await.unwrap().unwrap();
        assert_eq!(captured.len(),3);let expected=serde_json::to_vec(&payload).unwrap();
        for(_,body)in &captured{assert_eq!(*body,expected);}
        assert!(captured[0].0.contains("Bearer decision-key"));assert!(!captured[0].0.contains("answer-key"));
        assert!(captured[1].0.contains("Bearer answer-key"));assert!(!captured[1].0.contains("decision-key"));
        assert!(!captured[2].0.to_ascii_lowercase().contains("authorization:"));
    }
}

use std::future::Future;
pub async fn once<F, Fut, C, N>(
    enabled: bool,
    cancelled: C,
    mut attempt: F,
    mut notify: N,
) -> Result<(), String>
where
    F: FnMut(bool) -> Fut,
    Fut: Future<Output = Result<(), String>>,
    C: Fn() -> bool,
    N: FnMut(&str),
{
    let result = attempt(false).await;
    if let Err(primary) = result {
        if enabled && !cancelled() {
            notify(&primary);
            return attempt(true)
                .await
                .map_err(|e| format!("主服务：{primary}；备用服务：{e}"));
        }
        return Err(primary);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[tokio::test]
    async fn one_fallback_on_failure_none_after_success_or_cancel() {
        for (first_ok, cancelled, enabled, expected) in [
            (false, false, true, vec![false, true]),
            (true, false, true, vec![false]),
            (false, true, true, vec![false]),
            (false, false, false, vec![false]),
        ] {
            let calls = RefCell::new(Vec::new());
            let _ = once(
                enabled,
                || cancelled,
                |backup| {
                    calls.borrow_mut().push(backup);
                    async move {
                        if first_ok || backup {
                            Ok(())
                        } else {
                            Err("HTTP 503".into())
                        }
                    }
                },
                |_| {},
            )
            .await;
            assert_eq!(*calls.borrow(), expected);
        }
    }
}

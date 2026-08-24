use std::time::Duration;

const TELEGRAM_KEEP_ALIVE_HOST: &str = "api.telegram.org";
const TELEGRAM_KEEP_ALIVE_PORT: u16 = 443;
const TELEGRAM_KEEP_ALIVE_TIMEOUT: Duration = Duration::from_secs(5);

/// Best-effort Telegram reachability probe used only to keep VPN routes warm.
/// DNS is resolved for every probe so Telegram can change the serving address.
pub async fn probe_telegram() -> bool {
    matches!(
        tokio::time::timeout(
            TELEGRAM_KEEP_ALIVE_TIMEOUT,
            tokio::net::TcpStream::connect((TELEGRAM_KEEP_ALIVE_HOST, TELEGRAM_KEEP_ALIVE_PORT,)),
        )
        .await,
        Ok(Ok(_))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keep_alive_uses_a_hostname_instead_of_a_fixed_datacenter_ip() {
        assert_eq!(TELEGRAM_KEEP_ALIVE_HOST, "api.telegram.org");
        assert!(TELEGRAM_KEEP_ALIVE_HOST
            .parse::<std::net::IpAddr>()
            .is_err());
        assert_eq!(TELEGRAM_KEEP_ALIVE_PORT, 443);
        assert!(TELEGRAM_KEEP_ALIVE_TIMEOUT <= Duration::from_secs(5));
    }
}

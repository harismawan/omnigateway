use std::{
    io::{self, BufRead, BufReader, Write},
    net::TcpListener,
    process::Command,
    thread,
};

#[test]
fn health_probes_the_root_env_address_without_opening_a_database() -> io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let root = std::env::temp_dir().join(format!("omni-health-test-{}", std::process::id()));
    std::fs::create_dir(&root)?;
    std::fs::write(
        root.join(".env"),
        format!("OMNI_HOST=0.0.0.0\nOMNI_PORT={port}\n"),
    )?;
    let server = thread::spawn(move || -> io::Result<()> {
        let (stream, _) = listener.accept()?;
        stream.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
        let mut reader = BufReader::new(stream);
        let mut request = String::new();
        while !request.ends_with("\r\n\r\n") && reader.read_line(&mut request)? != 0 {}
        assert_eq!(
            request,
            format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
        );
        reader
            .get_mut()
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
    });
    let output = Command::new(env!("CARGO_BIN_EXE_omni"))
        .args(["health", "--root"])
        .arg(&root)
        .env_remove("OMNI_ENCRYPTION_KEY")
        .env_remove("OMNI_DB_PATH")
        .env("OMNI_PORT", "not-a-port")
        .output()?;
    let files = std::fs::read_dir(&root)?.count();
    std::fs::remove_file(root.join(".env"))?;
    assert_eq!(files, 1, "health wrote to the install root");
    std::fs::remove_dir(&root)?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.join().expect("server thread")
}

#[test]
fn env_only_probes_the_process_port_even_when_dotenv_sets_another_port() -> io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    // Hold the other port open without answering, so it cannot accidentally serve a 200.
    let dotenv_listener = TcpListener::bind("127.0.0.1:0")?;
    let root = std::env::temp_dir().join(format!("omni-health-env-only-{}", std::process::id()));
    std::fs::create_dir(&root)?;
    let dotenv = root.join(".env");
    std::fs::write(
        &dotenv,
        format!("OMNI_PORT={}\n", dotenv_listener.local_addr()?.port()),
    )?;
    let server = thread::spawn(move || -> io::Result<()> {
        let (stream, _) = listener.accept()?;
        stream.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
        let mut reader = BufReader::new(stream);
        let mut request = String::new();
        while !request.ends_with("\r\n\r\n") && reader.read_line(&mut request)? != 0 {}
        reader.get_mut().write_all(b"HTTP/1.1 200 OK\r\n\r\n")
    });
    let output = Command::new(env!("CARGO_BIN_EXE_omni"))
        .args(["health", "--env-only", "--root"])
        .arg(&root)
        .env("OMNI_HOST", "127.0.0.1")
        .env("OMNI_PORT", port.to_string())
        .output()?;
    std::fs::remove_file(dotenv)?;
    std::fs::remove_dir(root)?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.join().expect("server thread")
}

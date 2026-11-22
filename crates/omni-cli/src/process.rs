/// Frozen processAlive treats every signal-zero error, including EPERM, as dead.
/// Callers parse pidfiles first, excluding zero, negative and fractional values.
pub fn alive(pid: f64) -> bool {
    if !pid.is_finite() || pid <= 0.0 || pid > f64::from(i32::MAX) || pid.fract() != 0.0 {
        return false;
    }
    rustix::process::Pid::from_raw(pid as i32)
        .is_some_and(|pid| rustix::process::test_kill_process(pid).is_ok())
}

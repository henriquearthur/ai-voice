import Darwin

/// O lock da fala do Jarvis (~/.local/share/jarvis/fala.lock) é um flock(2) tomado pelo lockf(1)
/// de quem está tocando áudio. Ocupado = o Jarvis está falando.
public enum SpeechLock {
    /// true se outro processo segura o lock agora. Arquivo ausente = ninguém falando.
    public static func isHeld(_ path: String) -> Bool {
        let fd = open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        if flock(fd, LOCK_SH | LOCK_NB) == 0 {
            flock(fd, LOCK_UN)
            return false
        }
        return errno == EWOULDBLOCK
    }
}

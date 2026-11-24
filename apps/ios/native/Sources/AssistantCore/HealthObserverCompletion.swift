import Foundation

/// Finishes an OS delivery exactly once, including a racing cancellation/normal callback.
public final class HealthObserverCompletion {
    private let lock=NSLock()
    private var action: (() -> Void)?
    public init(_ action: @escaping () -> Void) { self.action=action }
    public func finish() { lock.lock(); let callback=action; action=nil; lock.unlock(); callback?() }
}

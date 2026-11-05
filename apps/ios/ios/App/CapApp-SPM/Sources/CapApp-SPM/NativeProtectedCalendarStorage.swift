import Foundation
import AssistantCore
import Darwin

/// Lowest file/lock boundary. Fake implementations are used only by qualification.
protocol NativeCalendarFileHandle:AnyObject {
    var current:Bool{get}
    func read()throws->Data?
    func replace(_ bytes:Data)throws
    func close()
}
protocol NativeCalendarFilePort {func openExclusive(snapshot:URL)throws->any NativeCalendarFileHandle}
struct NativeCalendarProtectedFilePort:NativeCalendarFilePort {
    private final class Handle:NativeCalendarFileHandle {
        let fd:Int32,path:String,device:dev_t,inode:ino_t,storage:ProtectedHealthFileStorage
        private var closed=false
        init(_ fd:Int32,_ path:String,_ info:stat,_ snapshot:URL){self.fd=fd;self.path=path;device=info.st_dev;inode=info.st_ino;storage=ProtectedHealthFileStorage(file:snapshot)}
        var current:Bool {var actual=stat();return !closed && lstat(path,&actual)==0 && actual.st_dev==device && actual.st_ino==inode && (actual.st_mode & S_IFMT)==S_IFREG && actual.st_uid==getuid()}
        func read()throws->Data?{guard current else{throw CocoaError(.fileReadNoPermission)};return try storage.read()}
        func replace(_ bytes:Data)throws{guard current else{throw CocoaError(.fileWriteNoPermission)};try storage.replace(bytes)}
        func close(){guard !closed else{return};closed=true;_ = flock(fd,LOCK_UN);_ = Darwin.close(fd)}
        deinit{close()}
    }
    func openExclusive(snapshot:URL)throws->any NativeCalendarFileHandle{
        guard snapshot.isFileURL,snapshot==snapshot.standardizedFileURL else{throw CocoaError(.fileReadInvalidFileName)}
        let directory=snapshot.deletingLastPathComponent();var attributes:[FileAttributeKey:Any]=[.posixPermissions:0o700]
        #if os(iOS)
        attributes[.protectionKey]=FileProtectionType.complete
        #endif
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:attributes)
        // A sidecar lock is coordination metadata, never a second snapshot/journal.
        let path=snapshot.path+".custody.lock",fd=Darwin.open(path,O_RDWR|O_CREAT|O_CLOEXEC|O_NOFOLLOW,0o600)
        guard fd>=0 else{throw CocoaError(.fileReadNoPermission)}
        var info=stat()
        guard fstat(fd,&info)==0,(info.st_mode & S_IFMT)==S_IFREG,info.st_uid==getuid(),fchmod(fd,0o600)==0,flock(fd,LOCK_EX|LOCK_NB)==0 else{_ = Darwin.close(fd);throw CocoaError(.fileReadNoPermission)}
        return Handle(fd,path,info,snapshot)
    }
}

/// Concrete ORIGINAL snapshot custodian. The OS lock spans the storage lifetime,
/// including ordinary Health reads/writes and all Calendar lease retirements.
/// Construction invokes no file, protection, status or SDK function.
final class NativeProtectedCalendarStorage:NativeSavedHealthStorageCustody {
    let identity:NativeHealthRuntime.RootConfiguration.Identity
    private let file:URL,port:any NativeCalendarFilePort,protectedAvailable:()->Bool,currentContext:()->Bool
    private let lock=NSRecursiveLock()
    private var handle:(any NativeCalendarFileHandle)?,lease:Lease?,failed=false
    private var savedWithdrawalOwner:ObjectIdentifier?,retired=false
    init(identity:NativeHealthRuntime.RootConfiguration.Identity,file:URL,port:any NativeCalendarFilePort,protectedAvailable:@escaping()->Bool,current:@escaping()->Bool){self.identity=identity;self.file=file;self.port=port;self.protectedAvailable=protectedAvailable;currentContext=current}
    func openStorage()throws->any HealthSnapshotStorage{
        lock.lock();defer{lock.unlock()}
        guard !retired,!failed,protectedAvailable(),currentContext() else{throw NativeCalendarAdmissionError.unavailable}
        if handle==nil{handle=try port.openExclusive(snapshot:file)}
        guard usable else{throw NativeCalendarAdmissionError.unavailable};return self
    }
    private var usable:Bool{!retired && !failed && protectedAvailable() && (savedWithdrawalOwner != nil || currentContext()) && handle?.current==true}
    func read()throws->Data?{lock.lock();defer{lock.unlock()};guard usable,let handle else{throw NativeCalendarAdmissionError.unavailable};return try handle.read()}
    func replace(_ bytes:Data)throws{
        lock.lock();defer{lock.unlock()};guard usable,let handle else{throw NativeCalendarAdmissionError.unavailable}
        do{try handle.replace(bytes)}catch{failed=true;throw error} // Ambiguous writes never reopen/reset.
    }
    func closeForSavedHealthRecovery(root:NativeSharedOutboxOwner,runtime:NativeHealthRuntime)throws{
        lock.lock();defer{lock.unlock()}
        guard !retired,!failed,savedWithdrawalOwner==nil,lease==nil,root.ownsOriginalStorage(self),runtime.mayReleaseSavedStorage(root) else{throw NativeCalendarAdmissionError.unavailable}
        // One-way close before extensible close callback. A failed/unknown store
        // never reaches this transition and can never be reopened/reset.
        retired=true;let original=handle;handle=nil;original?.close()
    }
    func savedHealthWithdrawalCurrent(root:NativeSharedOutboxOwner)->Bool{
        !retired && !failed && savedWithdrawalOwner==ObjectIdentifier(root)
    }
    /// Narrow metadata-only original-owner invalidation. The original exclusive
    /// handle, protection and failed-write latch still apply. Current Auth may
    /// already have changed; no ordinary file access is made current by this.
    func performSavedHealthWithdrawal(root:NativeSharedOutboxOwner,expected:HealthOutbox.SavedHealthSelection,disable:Bool,requireRebind:Bool)throws->HealthOutbox.SavedHealthSelection{
        lock.lock();defer{lock.unlock()}
        guard !retired,!failed,savedWithdrawalOwner==nil,root.ownsOriginalStorage(self),disable || requireRebind,
              expected.origin==identity.origin,expected.human==identity.human,expected.endpoint==identity.endpoint,
              protectedAvailable(),!retired,!failed,handle?.current==true else{throw NativeCalendarAdmissionError.unavailable}
        savedWithdrawalOwner=ObjectIdentifier(root);defer{savedWithdrawalOwner=nil}
        return try root.executeSavedHealthProtection(storage:self,expected:expected,disable:disable,requireRebind:requireRebind)
    }
    func performSavedHealthBackgroundOff(root:NativeSharedOutboxOwner,expected:HealthOutbox.SavedHealthSelection)throws->HealthOutbox.SavedHealthSelection{
        lock.lock();defer{lock.unlock()}
        guard !retired,!failed,savedWithdrawalOwner==nil,root.ownsOriginalStorage(self),
              expected.origin==identity.origin,expected.human==identity.human,expected.endpoint==identity.endpoint,
              protectedAvailable(),handle?.current==true else{throw NativeCalendarAdmissionError.unavailable}
        savedWithdrawalOwner=ObjectIdentifier(root);defer{savedWithdrawalOwner=nil}
        return try root.executeSavedHealthBackgroundOff(storage:self,expected:expected)
    }
    func acquire(storage:any HealthSnapshotStorage,binding:NativeSharedOutboxOwner.Binding)throws->any NativeSharedOutboxCustodyLease{
        lock.lock();defer{lock.unlock()}
        guard (storage as? NativeProtectedCalendarStorage) === self,lease==nil,usable,binding==self.binding else{throw NativeCalendarAdmissionError.unavailable}
        let original=Lease(self,binding);lease=original;return original
    }
    private var binding:NativeSharedOutboxOwner.Binding{.init(origin:identity.origin,human:identity.human,session:identity.session,endpoint:identity.endpoint)}
    private final class Lease:NativeCalendarReadPermissionCustody,NativeCalendarCommandCustody {
        let storage:NativeProtectedCalendarStorage,binding:NativeSharedOutboxOwner.Binding
        private var released=false
        init(_ storage:NativeProtectedCalendarStorage,_ binding:NativeSharedOutboxOwner.Binding){self.storage=storage;self.binding=binding}
        private var current:Bool{!released && storage.lease === self && storage.usable}
        func isCurrent(storage:any HealthSnapshotStorage,binding:NativeSharedOutboxOwner.Binding)->Bool{(storage as? NativeProtectedCalendarStorage) === self.storage && binding==self.binding && current}
        func withFence<T>(_ body:()throws->T)throws->T{storage.lock.lock();defer{storage.lock.unlock()};guard current else{throw NativeCalendarAdmissionError.stale};// Root rechecks reads after the entire fence. A known successful write
            // must stay known success if withdrawal occurred inside its body.
            return try body()}
        func admissionCurrency(binding:NativeCalendarAdmissionCurrency.Binding)->NativeCalendarAdmissionCurrency?{
            guard current,binding.root==storage.identity,binding.configuration.human==self.binding.human,binding.configuration.session==self.binding.session,binding.configuration.endpoint==self.binding.endpoint,binding.configuration.origin==self.binding.origin else{return nil};return .init(owner:self,binding:binding)
        }
        func readPermissionCurrency(binding:NativeCalendarReadPermissionCurrency.Binding)->NativeCalendarReadPermissionCurrency?{
            guard current,binding.root==storage.identity,binding.configuration.human==self.binding.human,binding.configuration.session==self.binding.session,binding.configuration.endpoint==self.binding.endpoint,binding.category=="CalendarEvent" else{return nil};return .init(owner:self,binding:binding)
        }
        func commandCurrency(binding:NativeCalendarCommandCurrency.Binding)->NativeCalendarCommandCurrency?{
            guard current,binding.root==storage.identity,["reconcileOriginal","reconcileTerminalOriginal","stageOriginal","markAttempted","settleOriginal"].contains(binding.purpose) else{return nil};return .init(owner:self,binding:binding)
        }
        func release(){storage.lock.lock();defer{storage.lock.unlock()};guard !released else{return};released=true;if storage.lease === self{storage.lease=nil}}
    }
    deinit{handle?.close()}
}

import Foundation

/// Native composition only. A profile is configuration, never source authority.
/// The existing Host still reads authenticated inventory and current policy.
final class NativeHealthConnectionOwner {
    final class Profile {
        let descriptor: NativeHealthSetupDescriptor
        private var bound = false
        private var revoked = false
        private weak var currency: NativeHealthChoiceCurrency?

        init?(descriptor: NativeHealthSetupDescriptor) {
            guard descriptor.valid else { return nil }
            self.descriptor = descriptor
        }

        /// The original configuration owner calls this BEFORE any bound change.
        /// Neither a vanished Host nor an unchanged replacement can rebind it.
        func revoke() {
            precondition(Thread.isMainThread)
            guard !revoked else { return }
            revoked = true
            currency?.revoke()
        }

        fileprivate func bind(host:NativeHealthHost,runtime:NativeHealthRuntime)->Bool {
            precondition(Thread.isMainThread)
            guard !bound,!revoked,host.canInstallHealthConfiguration(runtime:runtime),runtime.configuration==nil,runtime.choiceAdmissionAvailable else{return false}
            bound=true
            let original=NativeHealthChoiceCurrency(owner:self,descriptors:[descriptor]);currency=original
            return host.installHealthConfiguration(configuration:{[self] selector in
                guard !revoked,Data(selector.utf8)==Data(descriptor.selector.utf8) else{return nil}
                return descriptor.configuration
            },port:.init(owner:self,currency:original,descriptors:[descriptor]),runtime:runtime)
        }
        fileprivate func bind(transport: NativeTransport) -> NativeHealthHost? {
            precondition(Thread.isMainThread)
            guard !bound, !revoked else { return nil }
            bound = true
            let original = NativeHealthChoiceCurrency(owner: self, descriptors: [descriptor])
            currency = original
            return NativeHealthHost(transport: transport, configuration: { [self] selector in
                guard !revoked, Data(selector.utf8) == Data(descriptor.selector.utf8) else { return nil }
                return descriptor.configuration
            }, choicePort: .init(owner: self, currency: original, descriptors: [descriptor]))
        }
    }

    private(set) var host: NativeHealthHost
    private var profile: Profile?
    private let transport:NativeTransport
    private var calendarProfile:NativeCalendarSavedProfile?
    private var calendarReplacementPending=false,calendarReplacementReady=false

    /// No factories, storage, SDK or HTTP are invoked during construction.
    /// Missing or already-bound configuration gets the existing unavailable Host.
    init(transport: NativeTransport, profile: Profile? = nil) {
        precondition(Thread.isMainThread)
        self.transport=transport;calendarProfile=nil
        if let profile, let original = profile.bind(transport: transport) {
            self.profile = profile
            host = original
        } else {
            // A refused connection must not retain the original owner's revoke
            // capability merely because it was given that already-bound profile.
            self.profile = nil
            host = NativeHealthHost(transport: transport)
        }
    }

    /// Alternate ORIGINAL native Calendar composition; no installed provider.
    init(transport:NativeTransport,calendarProfile:NativeCalendarSavedProfile){
        precondition(Thread.isMainThread);self.transport=transport;profile=nil
        if let original=calendarProfile.bind(transport:transport){self.calendarProfile=calendarProfile;host=original}
        else{self.calendarProfile=nil;host=NativeHealthHost(transport:transport)}
    }

    func installHealthConfiguration(_ original:Profile,runtime:NativeHealthRuntime)->Bool {
        precondition(Thread.isMainThread)
        guard profile==nil,calendarProfile==nil,!calendarReplacementPending,!calendarReplacementReady,host.canInstallHealthConfiguration(runtime:runtime),
              original.bind(host:host,runtime:runtime) else{return false}
        profile=original;configuredHealthOriginal=nil;return true
    }
    private var configuredHealthOriginal:Profile?
    private var savedRecoveryRetiring=false
    var hasHealthConfigurationForSavedRecovery:Bool{profile != nil || configuredHealthOriginal != nil}
    var canEnterConfiguredHealthSettings:Bool{profile != nil && calendarProfile==nil && host.canEnterConfiguredHealthSettings}
    var configuredHealthSettingsControl:Bool{configuredHealthOriginal != nil && profile==nil && calendarProfile==nil && host.configuredHealthSettingsControl}
    func beginConfiguredHealthSettings(runtime original:NativeHealthRuntime,current:@escaping()->Bool)->String{
        precondition(Thread.isMainThread)
        if configuredHealthSettingsControl{return "settings"}
        if let old=configuredHealthOriginal{_ = old;return host.configuredHealthSettingsControl ? "settings":"retiring"}
        guard let profile,calendarProfile==nil,host.runtime === original,canEnterConfiguredHealthSettings,current() else{return "unavailable"}
        configuredHealthOriginal=profile
        let state=host.beginConfiguredHealthSettings(revoke:{profile.revoke()},current:current){[self] in
            guard self.profile === profile,host.runtime === original,current() else{return};self.profile=nil
        }
        // A refused preflight has not consumed the original profile. Retain no
        // retirement marker that would make a later explicit attempt look busy.
        if state=="unavailable"{configuredHealthOriginal=nil}
        return state
    }
    var canInstallCalendarConfiguration:Bool{profile==nil && !calendarReplacementPending && ((calendarProfile==nil && host.canInstallCalendarConfiguration) || (calendarReplacementReady && host.calendarReplacementRetired))}
    func retireCalendarConfiguration(completion:@escaping(Bool)->Void){
        precondition(Thread.isMainThread)
        guard profile==nil,let prior=calendarProfile,!calendarReplacementPending,!calendarReplacementReady else{completion(false);return}
        calendarReplacementPending=true;let original=host
        // Permanent revocation BEFORE any prospective settings mutation.
        prior.revoke()
        original.retireCalendarConfiguration{[self] ready in
            guard host === original,calendarProfile === prior,calendarReplacementPending else{return}
            calendarReplacementPending=false;calendarReplacementReady=ready;completion(ready)
        }
    }
    func installCalendarConfiguration(_ original:NativeCalendarSavedProfile)->Bool{
        precondition(Thread.isMainThread)
        guard canInstallCalendarConfiguration,let bound=original.bind(transport:transport) else{return false}
        // The previous Host is inert or has published its original retirement.
        host=bound;calendarProfile=original;calendarReplacementReady=false;return true
    }
    /// Sequential replacement only after the SAME old Host/Runtime and all
    /// original custody/publication frames have really retired.
    func retireHealthForSavedRecovery(original:NativeHealthRuntime,completion:@escaping(Result<NativeHealthRuntime.RetiredSavedHealthResources,Error>)->Void){
        precondition(Thread.isMainThread)
        guard !savedRecoveryRetiring,calendarProfile==nil,let old=profile ?? configuredHealthOriginal else{completion(.failure(NativeHealthRuntime.Failure.unavailable));return}
        savedRecoveryRetiring=true;let oldHost=host;old.revoke()
        oldHost.retireHealthForSavedRecovery(original:original){[self] ready in
            guard ready,host === oldHost,savedRecoveryRetiring else{return}
            DispatchQueue.main.async{[self] in
                do{
                    guard host === oldHost,savedRecoveryRetiring else{throw NativeHealthRuntime.Failure.stale}
                    let resources=try original.takeRetiredSavedHealthResources()
                    // The old physical file is closed before this new inert Host
                    // can ever admit a new original Root or Profile.
                    host=NativeHealthHost(transport:transport);profile=nil;configuredHealthOriginal=nil;savedRecoveryRetiring=false
                    completion(.success(resources))
                }catch{completion(.failure(error))} // Retain held old owner on uncertainty.
            }
        }
    }
    /// No configured interest means no factories/file/SDK/HTTP at startup.
    func setNativeHealthActivity(foreground:Bool,eligibleBackground:Bool){host.setNativeHealthActivity(foreground:foreground,eligibleBackground:eligibleBackground)}
    func foregroundHealthOpportunity(){host.observationForegroundOpportunity()}
    func withdraw(authorityChanged: Bool = false) {
        precondition(Thread.isMainThread)
        if authorityChanged { profile?.revoke();calendarProfile?.revoke() }
        // Keep this SAME Host, including its retiring/uncertain Runtime. A
        // temporary withdrawal does not manufacture a replacement configuration.
        host.withdraw(authorityChanged: authorityChanged)
    }
}

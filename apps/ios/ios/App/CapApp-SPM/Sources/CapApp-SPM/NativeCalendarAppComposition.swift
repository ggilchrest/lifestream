import Foundation
import AssistantCore
#if canImport(UIKit)
import UIKit
#endif
#if os(iOS) && canImport(HealthKit)
import HealthKit
#endif

/// One prospective original snapshot binding, shared by normal generations and
/// the forward recovery codec. No filesystem/SDK work occurs during registration.
/// This locator does not assert that installed state is absent or grant custody.
public final class NativeCalendarAppComposition {
    static let locationPolicyID="lifestream-native-mobile-context-store/1"
    static let relativeSnapshot="Library/Application Support/Lifestream/mobile-context.snapshot.json"
    static let mappingVersion="lifestream-eventkit/1"
    static let healthMappingVersion="lifestream-healthkit/1"
    final class Location {
        private let home:()->URL,knownOriginal:URL?
        private var original:URL?
        init(home:@escaping()->URL,knownOriginal:URL?=nil){self.home=home;self.knownOriginal=knownOriginal}
        func resolve(current:()->Bool)throws->URL{
            guard current() else{throw NativeCalendarAdmissionError.stale}
            if let original{return original}
            let base=home()
            guard current(),base.isFileURL,base==base.standardizedFileURL else{throw NativeCalendarAdmissionError.unavailable}
            let candidate=base.appendingPathComponent(NativeCalendarAppComposition.relativeSnapshot).standardizedFileURL
            // A supplied original binding must be provable at this exact locator.
            // Never scan, migrate, reset or fall back to another snapshot.
            guard knownOriginal==nil || knownOriginal==candidate,current() else{throw NativeCalendarAdmissionError.unavailable}
            original=candidate;return candidate
        }
    }
    final class Registration {
        let enabled:Bool
        private let resources:(()->NativeCalendarSourceOwner.Resources)?
        private var original:NativeCalendarSourceOwner?,transport:NativeTransport?,connection:NativeHealthConnectionOwner?
        private var binding=false,applicationBinding=false
        struct ApplicationOwners {let transport:NativeTransport,connection:NativeHealthConnectionOwner,source:NativeCalendarSourceOwner}
        private var application:ApplicationOwners?
        private var restoreID:UUID?,restoreCallbacks:[(Result<[String:Any],Error>)->Void]=[]
        private var foreground=false,background=false
        #if canImport(UIKit)
        private var lifecycleObservers:[NSObjectProtocol]=[]
        #endif

        init(enabled:Bool,resources:@escaping()->NativeCalendarSourceOwner.Resources){self.enabled=enabled;self.resources=enabled ? resources:nil}
        /// A single original process composition, also used by fake-port
        /// qualification. Registration is inert until this native entry.
        func applicationOwners(makeTransport:()->NativeTransport={NativeTransport()})->ApplicationOwners?{
            precondition(Thread.isMainThread)
            guard enabled,!applicationBinding else{return nil}
            if let application{return application}
            applicationBinding=true;defer{applicationBinding=false}
            let transport=makeTransport(),connection=NativeHealthConnectionOwner(transport:transport,profile:nil)
            guard let source=bind(transport:transport,connection:connection) else{return nil}
            let owners=ApplicationOwners(transport:transport,connection:connection,source:source)
            transport.healthContextTransition={[weak source] event in source?.observeHealthContextTransition(event)}
            transport.healthContextPairedWillChange={[weak source] changed,notice in source?.healthContextWillChange(authorityChanged:changed,notification:notice)}
            application=owners;return owners
        }
        func nativeOpportunity(foreground:Bool,background:Bool){
            precondition(Thread.isMainThread);self.foreground=foreground;self.background=background
            guard restoreID==nil,let application else{return}
            application.source.nativeHealthOpportunity(foreground:foreground,background:background)
        }
        func startApplication(foreground:Bool,background:Bool,makeTransport:()->NativeTransport={NativeTransport()}){
            guard applicationOwners(makeTransport:makeTransport) != nil else{return}
            self.foreground=foreground;self.background=background
            restoreApplicationConnection{_ in}
        }
        /// Coalesces only the same entered operation, not an Auth/credential
        /// cache. Later restore first drains the exact original source owner.
        func restoreApplicationConnection(_ completion:@escaping(Result<[String:Any],Error>)->Void){
            guard let application else{completion(.failure(VoiceError.staleTurn));return}
            restoreCallbacks.append(completion)
            guard restoreID==nil else{return}
            let id=UUID();restoreID=id
            application.source.prepareApplicationConnectionRestore{[self] in
                guard restoreID==id else{return}
                application.transport.restoreSession{[self] result in
                    let epoch=application.transport.epoch
                    let payload=result.map{ $0.payload } // No credential body retained.
                    func publish(_ value:Result<[String:Any],Error>){
                        DispatchQueue.main.async{[self] in
                            guard restoreID==id else{return}
                            let usable=application.transport.epoch==epoch ? value:.failure(VoiceError.staleTurn)
                            let callbacks=restoreCallbacks;restoreCallbacks=[];callbacks.forEach{$0(usable)}
                            DispatchQueue.main.async{[self] in
                                guard restoreID==id else{return}
                                if !restoreCallbacks.isEmpty{publish(usable)}else{restoreID=nil;nativeOpportunity(foreground:foreground,background:background)}
                            }
                        }
                    }
                    publish(payload)
                }
            }
        }
        #if canImport(UIKit)
        func startNativeLifecycle(){
            guard enabled,lifecycleObservers.isEmpty else{return}
            func state()->(Bool,Bool){let value=UIApplication.shared.applicationState;return(value == .active,value == .background)}
            let initial=state();startApplication(foreground:initial.0,background:initial.1)
            func observe(_ name:Notification.Name,_ action:@escaping()->Void){lifecycleObservers.append(NotificationCenter.default.addObserver(forName:name,object:nil,queue:.main){_ in action()})}
            observe(UIApplication.didBecomeActiveNotification){[weak self] in self?.nativeOpportunity(foreground:true,background:false)}
            observe(UIApplication.willResignActiveNotification){[weak self] in guard let self else{return};self.foreground=false;self.background=false;self.application?.source.nativeHealthInactive()}
            observe(UIApplication.didEnterBackgroundNotification){[weak self] in self?.nativeOpportunity(foreground:false,background:true)}
            observe(UIApplication.protectedDataWillBecomeUnavailableNotification){[weak self] in self?.nativeOpportunity(foreground:false,background:false)}
            observe(UIApplication.protectedDataDidBecomeAvailableNotification){[weak self] in let current=state();self?.nativeOpportunity(foreground:current.0,background:current.1)}
            observe(UIApplication.willTerminateNotification){[weak self] in self?.nativeOpportunity(foreground:false,background:false)}
        }
        deinit{lifecycleObservers.forEach{NotificationCenter.default.removeObserver($0)}}
        #endif
        func bind(transport:NativeTransport,connection:NativeHealthConnectionOwner)->NativeCalendarSourceOwner?{
            precondition(Thread.isMainThread)
            guard enabled,!binding else{return nil}
            if let original{return self.transport === transport && self.connection === connection ? original:nil}
            guard connection.canInstallCalendarConfiguration,let resources else{return nil}
            // Reserve BEFORE the extensible resources callback. Reentry must not
            // construct or publish another SourceOwner, even for identical ports.
            binding=true;defer{binding=false}
            let inputs=resources()
            guard connection.canInstallCalendarConfiguration else{return nil}
            let value=NativeCalendarSourceOwner(transport:transport,connection:connection,resources:inputs)
            self.transport=transport;self.connection=connection;original=value;return value
        }
    }
    /// The real view controller and headless qualification call this same factory.
    /// Inputs are capabilities, never installed identities, grants or date ranges.
    static func registration(resources:@escaping()->NativeCalendarSourceOwner.Resources)->Registration{
        #if LIFESTREAM_NATIVE_RECOVERY_DISABLED
        return Registration(enabled:false,resources:resources)
        #else
        return Registration(enabled:true,resources:resources)
        #endif
    }
    #if canImport(UIKit) && canImport(EventKit)
    private static var applicationRegistration:Registration?
    static func standardApplicationRegistration()->Registration{
        if let applicationRegistration{return applicationRegistration}
        let value=standardRegistration();applicationRegistration=value;return value
    }
    public static func applicationDidLaunch(){standardApplicationRegistration().startNativeLifecycle()}
    static func standardRegistration()->Registration{
        let location=Location(home:{URL(fileURLWithPath:NSHomeDirectory(),isDirectory:true)})
        let health:NativeCalendarSourceOwner.HealthResources?
        #if os(iOS) && canImport(HealthKit)
        health = .init(mappingVersion:healthMappingVersion,makeSDK:{HealthKitSDK(health:HKHealthStore())})
        #else
        health = nil
        #endif
        return registration {
            NativeCalendarSourceOwner.Resources(resolveFile:{current in try location.resolve(current:current)},filePort:NativeCalendarProtectedFilePort(),limits:.init(maxTotalDays:366,maxScans:8,maxSelectedCalendars:32)!,maxBytes:8*1024*1024,maxEvents:100000,mappingVersion:mappingVersion,protectedAvailable:{UIApplication.shared.isProtectedDataAvailable},clock:{
                let milliseconds=(Date().timeIntervalSince1970*1000).rounded(.down)
                return Date(timeIntervalSince1970:milliseconds/1000)
            },makeSDK:{NativeEventKitCalendarSelectionSDK()},deliveryContract:.selected,health:health)
        }
    }
    #endif
}

import Foundation
import AssistantCore

struct NativeCalendarMetadata:Equatable {
    let containerID:String,sourceID:String,title:String,sourceTitle:String,sourceKind:String
    let delegated:Bool?
    // Provider-local identities and captured metadata bind exact bytes, matching
    // the producing selection commitment. Swift canonical equivalence is wider.
    static func ==(a:Self,b:Self)->Bool{
        zip([a.containerID,a.sourceID,a.title,a.sourceTitle,a.sourceKind],[b.containerID,b.sourceID,b.title,b.sourceTitle,b.sourceKind]).allSatisfy{Data($0.0.utf8)==Data($0.1.utf8)} && a.delegated==b.delegated
    }
    // Public EventKit has no general shared-calendar owner identity property.
    var json:[String:Any]{["title":title,"sourceTitle":sourceTitle,"sourceKind":sourceKind,"sourceIdentity":sourceID,"calendarIdentity":containerID,"delegatedAccount":delegated as Any? ?? NSNull(),"ownership":"unknown","sharing":"unknown"]}
    var valid:Bool{[containerID,sourceID,title,sourceTitle,sourceKind].allSatisfy{!$0.isEmpty && $0.utf8.count<=1024 && !$0.unicodeScalars.contains{$0.value<32}}}
}
protocol NativeCalendarSelectionSDK:NativeCalendarReadPermissionSDK {
    var capturedDefaultTimeZone:TimeZone{get}
    func eventCalendars(current:()->Bool)throws->[NativeCalendarMetadata]
    func acquisition(outbox:HealthOutbox,selected:[NativeCalendarMetadata],current:()->Bool)->MobileEventKitAcquisition?
}
/// Low-level SDK object ports, not source policy or a replacement SDK owner.
/// The original adapter is shared by the real store and fake qualification ports.
protocol NativeCalendarSelectedCalendar {var metadata:NativeCalendarMetadata?{get}}
protocol NativeCalendarSelectionPort:NativeCalendarReadPermissionSDK {
    var capturedDefaultTimeZone:TimeZone{get}
    func eventCalendars(current:()->Bool)throws->[NativeCalendarMetadata]
    func calendar(identifier:String,current:()->Bool)->(any NativeCalendarSelectedCalendar)?
    func makeAcquisition(outbox:HealthOutbox,calendars:[any NativeCalendarSelectedCalendar],current:()->Bool)->MobileEventKitAcquisition?
}
class NativeCalendarSelectionAdapter:NativeCalendarSelectionSDK {
    private let original:any NativeCalendarSelectionPort
    init(original:any NativeCalendarSelectionPort){self.original=original}
    var capturedDefaultTimeZone:TimeZone{original.capturedDefaultTimeZone}
    func access(category:String)->NativeCalendarReadAccess{original.access(category:category)}
    func request(category:String,current:()->Bool,completion:@escaping(Bool,Error?)->Void)->Bool{original.request(category:category,current:current,completion:completion)}
    func eventCalendars(current:()->Bool)throws->[NativeCalendarMetadata]{
        guard current() else{throw NativeCalendarAdmissionError.stale}
        let access=original.access(category:"CalendarEvent")
        // Callback-free operation gate is LAST after the extensible status call.
        guard access == .fullRead,current() else{throw NativeCalendarAdmissionError.stale}
        let rows=try original.eventCalendars(current:current)
        guard current() else{throw NativeCalendarAdmissionError.stale};return rows
    }
    func acquisition(outbox:HealthOutbox,selected:[NativeCalendarMetadata],current:()->Bool)->MobileEventKitAcquisition?{
        guard !selected.isEmpty,selected.count<=32,current() else{return nil}
        let access=original.access(category:"CalendarEvent")
        guard access == .fullRead,current() else{return nil}
        var calendars:[any NativeCalendarSelectedCalendar]=[]
        for wanted in selected{
            // Nothing extensible between this gate and the real lookup delegate.
            guard current(),let calendar=original.calendar(identifier:wanted.containerID,current:current),current() else{return nil}
            let actual=calendar.metadata
            guard actual==wanted,current() else{return nil};calendars.append(calendar)
        }
        guard current() else{return nil}
        return original.makeAcquisition(outbox:outbox,calendars:calendars,current:current)
    }
}
#if canImport(EventKit)
import EventKit
/// One lazy long-lived ORIGINAL store for permission, metadata and events.
/// Constructed only by the supplied factory during an explicit native action.
final class NativeEventKitCalendarSelectionSDK:NativeCalendarSelectionAdapter {
    init(){super.init(original:NativeEventKitCalendarPort())}
}
private final class NativeEventKitCalendarObject:NativeCalendarSelectedCalendar {
    let calendar:EKCalendar
    init(_ calendar:EKCalendar){self.calendar=calendar}
    var metadata:NativeCalendarMetadata?{NativeEventKitCalendarPort.metadata(calendar)}
}
private final class NativeEventKitCalendarPort:NativeCalendarSelectionPort {
    private let store:EKEventStore,permission:NativeEventKitReadPermissionSDK
    init(){let original=EKEventStore();store=original;permission=NativeEventKitReadPermissionSDK(originalStore:original)}
    var capturedDefaultTimeZone:TimeZone{NSTimeZone.default}
    func access(category:String)->NativeCalendarReadAccess{category=="CalendarEvent" ? permission.access(category:category):.unknown}
    func request(category:String,current:()->Bool,completion:@escaping(Bool,Error?)->Void)->Bool{guard category=="CalendarEvent" else{return false};return permission.request(category:category,current:current,completion:completion)}
    static func metadata(_ c:EKCalendar)->NativeCalendarMetadata?{
        guard c.allowedEntityTypes.contains(.event),let source=c.source else{return nil}
        let kind:String
        switch source.sourceType{case .local:kind="Local";case .exchange:kind="Exchange";case .calDAV:kind="CalDAV";case .mobileMe:kind="iCloud";case .subscribed:kind="Subscribed";case .birthdays:kind="Birthdays";@unknown default:kind="Unknown"}
        let delegated:Bool?;if #available(iOS 16,macOS 13,*){delegated=source.isDelegate}else{delegated=nil}
        return .init(containerID:c.calendarIdentifier,sourceID:source.sourceIdentifier,title:c.title,sourceTitle:source.title,sourceKind:kind,delegated:delegated)
    }
    func eventCalendars(current:()->Bool)throws->[NativeCalendarMetadata]{
        // Status has already returned through the original adapter. Recheck the
        // same pure gate immediately before entering the actual OS delegate.
        guard current() else{throw NativeCalendarAdmissionError.stale}
        let rows=store.calendars(for:.event);guard rows.count<=256 else{throw NativeCalendarAdmissionError.unavailable}
        var values:[NativeCalendarMetadata]=[]
        for row in rows{guard current(),let value=Self.metadata(row),current() else{throw NativeCalendarAdmissionError.stale};values.append(value)}
        return values
    }
    func calendar(identifier:String,current:()->Bool)->(any NativeCalendarSelectedCalendar)?{guard current() else{return nil};return store.calendar(withIdentifier:identifier).map(NativeEventKitCalendarObject.init)}
    func makeAcquisition(outbox:HealthOutbox,calendars:[any NativeCalendarSelectedCalendar],current:()->Bool)->MobileEventKitAcquisition?{
        let actual=calendars.compactMap{($0 as? NativeEventKitCalendarObject)?.calendar};guard actual.count==calendars.count,current() else{return nil}
        return MobileEventKitAcquisition(outbox:outbox,store:store,selectedCalendars:actual,executeOnWorker:{work in DispatchQueue.global(qos:.userInitiated).async(execute:work)})
    }
}
#endif

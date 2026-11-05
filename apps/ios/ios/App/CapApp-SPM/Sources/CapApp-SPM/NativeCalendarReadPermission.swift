import Foundation

#if canImport(EventKit)
import EventKit
/// Source-only adapter; caller must supply its ORIGINAL long-lived store.
/// No construction, records, queries, writes, observers, or installed default.
final class NativeEventKitReadPermissionSDK:NativeCalendarReadPermissionSDK {
    private let store:EKEventStore
    init(originalStore:EKEventStore){store=originalStore}
    func access(category:String)->NativeCalendarReadAccess{
        guard category=="CalendarEvent" || category=="Task" else{return .unknown}
        let status=EKEventStore.authorizationStatus(for:category=="CalendarEvent" ? .event:.reminder)
        if #available(iOS 17,macOS 14,*){if status == .fullAccess{return .fullRead};if status == .writeOnly{return .writeOnly}}
        else if status == .authorized{return .fullRead}
        if status == .denied{return .denied};if status == .restricted{return .restricted};if status == .notDetermined{return .notDetermined};return .unknown
    }
    func request(category:String,current:()->Bool,completion:@escaping(Bool,Error?)->Void)->Bool{
        precondition(Thread.isMainThread)
        guard category=="CalendarEvent" || category=="Task" else{return false}
        if #available(iOS 17,macOS 14,*){
            if category=="CalendarEvent"{guard current() else{return false};store.requestFullAccessToEvents(completion:completion)}
            else{guard current() else{return false};store.requestFullAccessToReminders(completion:completion)}
        }else{let entity:EKEntityType=category=="CalendarEvent" ? .event:.reminder;guard current() else{return false};store.requestAccess(to:entity,completion:completion)}
        return true
    }
}
#endif

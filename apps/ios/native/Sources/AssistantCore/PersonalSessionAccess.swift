// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Local readiness is derived only from a server response. It grants no server authority.
public struct PersonalSessionAccess {
    public private(set) var enabled=false
    public private(set) var generation=0
    public private(set) var policy:String?
    public init() {}
    public mutating func withdraw(){generation &+= 1;enabled=false;policy=nil}
    /// Network/5xx and unrelated conflicts leave the last visible session intact.
    /// Callers independently stop transport when appropriate.
    @discardableResult public mutating func observe(status:Int,data:Data,ticket:Int,expectedPrincipal:String?=nil,expectedSession:String?=nil,now:Date=Date())->Bool {
        guard generation==ticket else{return enabled}
        if status==200 {
            guard let body=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else{withdraw();return false}
            let name=body["personalSessionPolicy"] as? String
            let expiryValid:Bool
            if body["expiresAt"] is NSNull {expiryValid=true}
            else if let raw=body["expiresAt"] as? String {
                let parser=ISO8601DateFormatter();parser.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
                let date=parser.date(from:raw) ?? ISO8601DateFormatter().date(from:raw)
                expiryValid=date.map{$0>now} ?? false
            } else {expiryValid=false}
            let legacy=name == "personalDevice" && body["personalSessionState"] as? String == "unlocked" && body["privateAllowed"] as? Bool == true
            let app=name == "personalApp" && body["personalSessionState"] as? String == "authenticated" && body["privateAllowed"] as? Bool == true && body["enforced"] as? Bool == true && expiryValid && body["leaseId"] is NSNull && body["leaseExpiresAt"] is NSNull && (body["revision"] as? Int).map{$0>=0} == true && expectedPrincipal != nil && expectedSession != nil && body["principalId"] as? String == expectedPrincipal && body["authenticatedSessionId"] as? String == expectedSession
            if legacy || app {enabled=true;policy=name}else{withdraw()}
        } else if status==401 || status==403 {withdraw()}
        else if status==409,let body=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],["effective_context_changed","effective_context_invalid_reference"].contains(body["code"] as? String ?? ""){withdraw()}
        return enabled
    }
}

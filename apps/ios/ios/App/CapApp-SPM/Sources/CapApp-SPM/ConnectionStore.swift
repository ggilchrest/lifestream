// SPDX-License-Identifier: Apache-2.0
import Foundation
import Security

struct SavedCookie: Codable { let name:String; let value:String }
struct SavedConnection: Codable {
    let endpoint:String
    let username:String
    var cookies:[SavedCookie]=[]
    var settings:String?
    var password:String?
    var requiresOneTimeCode:Bool?
    var hasSession:Bool { !cookies.isEmpty }
    var hasSavedCredentials:Bool { !(password ?? "").isEmpty }
}
protocol ConnectionStore {
    func load() throws -> SavedConnection?
    func save(_ value:SavedConnection) throws
}
enum ConnectionStorageError: Error { case unavailable(OSStatus), invalidRecord }
/// Device-only credential custody. No OTP, CSRF token or cloud synchronization.
final class KeychainConnectionStore: ConnectionStore {
    private let identity:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"org.lifestream.assistant.connection",kSecAttrAccount as String:"current",kSecAttrSynchronizable as String:false]
    func load() throws -> SavedConnection? {
        var query=identity;query[kSecReturnData as String]=true;query[kSecMatchLimit as String]=kSecMatchLimitOne
        var result:CFTypeRef?;let status=SecItemCopyMatching(query as CFDictionary,&result)
        if status==errSecItemNotFound{return nil}
        guard status==errSecSuccess else{throw ConnectionStorageError.unavailable(status)}
        guard let bytes=result as? Data,bytes.count<=65536 else{throw ConnectionStorageError.invalidRecord}
        return try JSONDecoder().decode(SavedConnection.self,from:bytes)
    }
    func save(_ value:SavedConnection) throws {
        let bytes=try JSONEncoder().encode(value);guard bytes.count<=65536 else{throw ConnectionStorageError.invalidRecord}
        let attributes:[String:Any]=[kSecValueData as String:bytes,kSecAttrAccessible as String:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status=SecItemUpdate(identity as CFDictionary,attributes as CFDictionary)
        if status==errSecItemNotFound {status=SecItemAdd(identity.merging(attributes){_,new in new} as CFDictionary,nil)}
        guard status==errSecSuccess else{throw ConnectionStorageError.unavailable(status)}
    }
}

// SPDX-License-Identifier: Apache-2.0
import Foundation

public struct AudioInputPort:Equatable {
    public let id:String,label:String,builtIn:Bool
    public init(id:String,label:String,builtIn:Bool){self.id=id;self.label=label;self.builtIn=builtIn}
}
public struct AudioInputOption:Equatable {
    public let id:String,label:String
    public init(id:String,label:String){self.id=id;self.label=label}
}
public enum AudioInputSelectionError:LocalizedError {
    case unavailable
    public var errorDescription:String?{"The chosen microphone is unavailable or iOS routed a different input. Open Microphone, choose an available input or System default, then tap Start."}
}
/// Selection is a deferred preference, resolved against fresh native inputs at Start.
public enum AudioInputSelection {
    private static func valid(_ id:String)->Bool {
        !id.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && id.utf8.count<=512 &&
        !id.unicodeScalars.contains{CharacterSet.controlCharacters.contains($0)} && !["system","builtin"].contains(id)
    }
    private static func label(_ input:String)->String {
        let clean=input.unicodeScalars.map{CharacterSet.whitespacesAndNewlines.contains($0) ? " ":CharacterSet.controlCharacters.contains($0) ? "":String($0)}.joined()
        let value=clean.split(whereSeparator:{$0.isWhitespace}).joined(separator:" ")
        return value.isEmpty ? "Microphone":String(value.prefix(80))
    }
    public static func options(_ ports:[AudioInputPort])->[AudioInputOption]{
        var result=[AudioInputOption(id:"system",label:"System default (automatic)"),AudioInputOption(id:"builtin",label:"iPhone microphone")],seen=Set<String>()
        for port in ports where !port.builtIn && valid(port.id){
            if seen.insert(port.id).inserted{result.append(AudioInputOption(id:port.id,label:label(port.label)))}
            if result.count==10{break}
        }
        return result
    }
    public static func isRouted(_ selection:String,ports:[AudioInputPort],currentIds:[String])->Bool {
        if selection=="system"{return !currentIds.isEmpty}
        guard let wanted=try? resolve(selection,ports:ports) else{return false}
        return currentIds.contains(wanted)
    }
    public static func resolve(_ selection:String,ports:[AudioInputPort]) throws -> String? {
        if selection=="system"{return nil}
        if selection=="builtin",let port=ports.first(where:{$0.builtIn && valid($0.id)}){return port.id}
        if valid(selection),let port=ports.first(where:{$0.id==selection && valid($0.id)}){return port.id}
        throw AudioInputSelectionError.unavailable
    }
}

import Foundation
import CryptoKit
let root=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any]
let vectors=root["vectors"] as! [[String:Any]]
guard vectors.count==9 else{exit(2)}
for item in vectors {
 let data=try JSONSerialization.data(withJSONObject:item["request"]!,options:[.sortedKeys,.withoutEscapingSlashes])
 let digest=SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()
 guard data==Data((item["canonicalUtf8"] as! String).utf8),digest==item["sha256"] as? String else{exit(3)}
}
let malformed=Data("{\"s\":\"\\ud800\"}".utf8)
do {_ = try JSONSerialization.jsonObject(with:malformed);exit(4)}catch{}
print("9 canonical synthetic vectors matched; unpaired surrogate rejected")

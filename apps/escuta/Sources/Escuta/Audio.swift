import AVFoundation
import CoreAudio

// MARK: CoreAudio

enum Audio {
    static func address(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }
    static func devices() -> [AudioDeviceID] {
        var addr = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
        return ids
    }
    static func name(_ id: AudioDeviceID) -> String {
        var addr = address(kAudioObjectPropertyName)
        var n: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &n) == noErr, let v = n else { return "?" }
        return v.takeRetainedValue() as String
    }
    static func transport(_ id: AudioDeviceID) -> UInt32 {
        var addr = address(kAudioDevicePropertyTransportType)
        var t: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &t)
        return t
    }
    static func isBluetooth(_ id: AudioDeviceID) -> Bool {
        let t = transport(id)
        return t == kAudioDeviceTransportTypeBluetooth || t == kAudioDeviceTransportTypeBluetoothLE
    }
    static func hasInput(_ id: AudioDeviceID) -> Bool {
        var addr = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput)
        var size: UInt32 = 0
        AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size)
        return size > 0
    }
    static func rate(_ id: AudioDeviceID) -> Double {
        var addr = address(kAudioDevicePropertyNominalSampleRate)
        var r: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &r)
        return r
    }
    static func defaultDevice(_ sel: AudioObjectPropertySelector) -> AudioDeviceID {
        var addr = address(sel)
        var id: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
        return id
    }
    /// AudioDeviceID a partir do uniqueID do AVCaptureDevice (é o UID do CoreAudio).
    static func device(uid: String) -> AudioDeviceID? {
        devices().first { id in
            var addr = address(kAudioDevicePropertyDeviceUID)
            var u: Unmanaged<CFString>?
            var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &u) == noErr, let v = u else { return false }
            return (v.takeRetainedValue() as String) == uid
        }
    }

    /// Volume de entrada no máximo e mic sem mudo, no elemento principal e em cada canal que aceitar.
    /// Mexe só no escopo de entrada: o volume de saída fica como está. Devolve o que foi ajustado.
    @discardableResult
    static func maximizeInput(_ id: AudioDeviceID) -> [String] {
        var done: [String] = []
        for el: UInt32 in 0...8 {
            var vol = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar,
                                                 mScope: kAudioObjectPropertyScopeInput, mElement: el)
            var settable: DarwinBoolean = false
            if AudioObjectHasProperty(id, &vol), AudioObjectIsPropertySettable(id, &vol, &settable) == noErr, settable.boolValue {
                var before: Float32 = 0
                var size = UInt32(MemoryLayout<Float32>.size)
                AudioObjectGetPropertyData(id, &vol, 0, nil, &size, &before)
                var one: Float32 = 1
                if AudioObjectSetPropertyData(id, &vol, 0, nil, size, &one) == noErr {
                    done.append("volume[\(el)] \(String(format: "%.2f", before))→1.00")
                }
            }
            var mute = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute,
                                                  mScope: kAudioObjectPropertyScopeInput, mElement: el)
            if AudioObjectHasProperty(id, &mute), AudioObjectIsPropertySettable(id, &mute, &settable) == noErr, settable.boolValue {
                var m: UInt32 = 0
                var size = UInt32(MemoryLayout<UInt32>.size)
                AudioObjectGetPropertyData(id, &mute, 0, nil, &size, &m)
                if m != 0 {
                    var zero: UInt32 = 0
                    if AudioObjectSetPropertyData(id, &mute, 0, nil, size, &zero) == noErr { done.append("mudo[\(el)] desligado") }
                }
            }
        }
        return done
    }

    static func setDefaultInput(_ id: AudioDeviceID) {
        var addr = address(kAudioHardwarePropertyDefaultInputDevice)
        var dev = id
        AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &dev)
    }
}


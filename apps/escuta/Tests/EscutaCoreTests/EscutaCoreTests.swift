import Foundation
import Testing
@testable import EscutaCore

@Suite struct WakeTests {
    @Test func comandoDepoisDoJarvis() {
        let c = Wake.command(in: "Jarvis, abre a agenda de amanhã.")
        #expect(c?.rest == "abre a agenda de amanhã")
    }

    @Test func variacaoDaTranscricao() {
        #expect(Wake.command(in: "Jarbas que horas são?")?.rest == "que horas são")
        #expect(Wake.command(in: "Camarada, liga a luz")?.rest == "liga a luz")
    }

    @Test func noMeioDaFraseNaoConta() {
        #expect(Wake.command(in: "eu falei com o Jarvis ontem") == nil)
    }

    @Test func depoisDeUmPontoConta() {
        #expect(Wake.command(in: "Pronto, já está feito. Jarvis, obrigado")?.rest == "obrigado")
    }

    @Test func prefixoParecidoComJarvisSai() {
        #expect(Wake.stripPrefix("Jardes, liga a luz da sala.") == "liga a luz da sala")
        #expect(Wake.stripPrefix("Jarvas que horas são?") == "que horas são")
        #expect(Wake.stripPrefix("na verdade muda pra amanhã") == "na verdade muda pra amanhã")
    }

    @Test func ruidoNaoViraPedido() {
        #expect(BargeIn.isNoise("."))
        #expect(BargeIn.isNoise("Hum."))
        #expect(BargeIn.isNoise("L"))
        #expect(BargeIn.isNoise("Mm-hmm."))  // o Parakeet escreve assim o balbucio
        #expect(!BargeIn.isNoise("ok"))
        #expect(!BargeIn.isNoise("sim"))
    }

    @Test func jarvisSozinho() {
        #expect(Wake.command(in: "Jarvis.")?.rest == "")
    }
}

@Suite struct EndpointTests {
    let c = EndpointConfig(silence: 1.0, openSilence: 2.5, settle: 0.4, finalizeWait: 1.5, maxUtterance: 120)

    func d(_ t: String, volatile: Bool = false, silence: Double, sinceText: Double? = nil, fin: Double? = 0.3,
           elapsed: Double = 5) -> EndpointDecision {
        Endpoint.decide(text: t, volatile: volatile, silence: silence, sinceText: sinceText ?? silence,
                        sinceFinalize: fin, elapsed: elapsed, config: c)
    }

    @Test func frasesAbertas() {
        #expect(Endpoint.endsOpen("Jarvis, quero ver a agenda e"))
        #expect(Endpoint.endsOpen("Jarvis, manda uma mensagem pra"))
        #expect(Endpoint.endsOpen("Jarvis, olha só,"))
        #expect(Endpoint.endsOpen("Jarvis, abre o calendário porque."))
        #expect(Endpoint.endsOpen("Jarvis, então..."))
        #expect(Endpoint.endsOpen("Jarvis"))
    }

    @Test func frasesFechadas() {
        #expect(!Endpoint.endsOpen("Jarvis, que horas são?"))
        #expect(!Endpoint.endsOpen("Jarvis, abre a agenda de amanhã."))
        #expect(!Endpoint.endsOpen("Jarvis, o que é"))
        #expect(!Endpoint.endsOpen(""))
    }

    @Test func falandoNaoFecha() {
        #expect(d("Jarvis, abre a agenda", silence: 0.3) == .wait)
    }

    @Test func pausaPedeOsFinaisAntes() {
        #expect(d("Jarvis, abre a agenda", volatile: true, silence: 1.1, fin: nil) == .finalize)
    }

    @Test func fraseCompletaFechaRapido() {
        #expect(d("Jarvis, abre a agenda de amanhã.", silence: 1.1) == .close("silêncio"))
    }

    @Test func textoAindaMudandoEspera() {
        #expect(d("Jarvis, abre a agenda", silence: 1.5, sinceText: 0.2) == .wait)
    }

    @Test func conectivoEsperaMais() {
        #expect(d("Jarvis, abre a agenda e", silence: 1.5) == .wait)
        #expect(d("Jarvis, abre a agenda,", silence: 2.0) == .wait)
        #expect(d("Jarvis, abre a agenda e", silence: 2.6) == .close("silêncio após frase aberta"))
    }

    @Test func esperaOFinalDoTrechoEmRevisao() {
        #expect(d("Jarvis, abre a agenda", volatile: true, silence: 1.2, fin: 0.2) == .wait)
        #expect(d("Jarvis, abre a agenda", volatile: true, silence: 2.8, fin: 1.6) == .close("silêncio"))
    }

    @Test func limiteDeDuracao() {
        #expect(d("Jarvis, e", volatile: true, silence: 0, elapsed: 121) == .close("limite de 120 s"))
    }
}

@Suite struct BargeInTests {
    @Test func palavraSoltaSemVozNaoValeNada() {
        // O "Não." que o reconhecedor inventou com o microfone em silêncio.
        #expect(BargeIn.isWeak("Não.", confidence: 0.9, hadVoice: false))
        #expect(BargeIn.isWeak("Não", confidence: 0.3, hadVoice: true))
        #expect(!BargeIn.isWeak("Não", confidence: 0.72, hadVoice: true))
        #expect(!BargeIn.isWeak("liga a luz da sala", confidence: 0.2, hadVoice: false))
    }

    @Test func soPararNaoViraPedido() {
        #expect(BargeIn.isOnlyStop("para"))
        #expect(BargeIn.isOnlyStop("espera aí"))
        #expect(!BargeIn.isOnlyStop("para de tocar música na sala"))
    }
}

@Suite struct SpeechLockTests {
    @Test func arquivoAusenteEstaLivre() {
        #expect(!SpeechLock.isHeld("/tmp/nao-existe-\(UUID().uuidString).lock"))
    }

    @Test func lockOcupadoPorOutroProcesso() throws {
        let path = NSTemporaryDirectory() + "escuta-teste-\(UUID().uuidString).lock"
        FileManager.default.createFile(atPath: path, contents: nil)
        defer { try? FileManager.default.removeItem(atPath: path) }
        #expect(!SpeechLock.isHeld(path))
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/lockf")
        p.arguments = ["-k", path, "/bin/sleep", "2"]
        try p.run()
        Thread.sleep(forTimeInterval: 0.5)
        #expect(SpeechLock.isHeld(path))
        p.waitUntilExit()
        #expect(!SpeechLock.isHeld(path))
    }
}

@Suite struct VadGateTests {
    func run(_ ps: [Float], _ c: VadGate.Config = .init()) -> [VadGate.Step] {
        var g = VadGate(config: c)
        return ps.map { g.step($0) }
    }

    @Test func ruidoAbaixoDoLimiarNuncaAbreFala() {
        #expect(run([0.1, 0.45, 0.3, 0.49, 0.2]).allSatisfy { $0 == .silence })
    }

    @Test func falaAbreEFechaDepoisDoSilencio() {
        #expect(run([0.1, 0.9, 0.8, 0.1, 0.1, 0.1]) == [.silence, .start, .speech, .speech, .speech, .end(valid: true)])
    }

    @Test func pausaCurtaNaoCortaAFala() {
        // Um bloco de silêncio no meio (respiração) não fecha; a histerese segura 0,4 como voz.
        #expect(run([0.9, 0.2, 0.4, 0.9, 0.1, 0.1, 0.1]) == [.start, .speech, .speech, .speech, .speech, .speech, .end(valid: true)])
    }

    @Test func microfoneBaixoAbreComProbabilidadeMeia() {
        #expect(run([0.52, 0.3, 0.1]) == [.start, .speech, .speech])
    }

    @Test func pausaDeMeioSegundoNaoDivideAFala() {
        // Dois blocos (~0,5 s) de silêncio e a fala volta: continua a mesma fala.
        #expect(run([0.9, 0.1, 0.1, 0.8]) == [.start, .speech, .speech, .speech])
    }

    @Test func estaloCurtoNaoVaiAoReconhecedor() {
        let c = VadGate.Config(minVoicedChunks: 2)
        #expect(run([0.95, 0.1, 0.1, 0.1], c) == [.start, .speech, .speech, .end(valid: false)])
    }

    @Test func vozDentroDaFalaUsaOLimiarMaisBaixo() {
        var g = VadGate()
        #expect(!g.isVoice(0.4))
        _ = g.step(0.9)
        #expect(g.isVoice(0.3))
        #expect(!g.isVoice(0.2))
    }
}

@Suite struct EndpointJuncaoTests {
    @Test func palavrasAbertasNovas() {
        for t in ["E de preferência de uma", "pode ser, tá", "isso não", "faz isso pra", "mas"] {
            #expect(Endpoint.endsOpen(t), "\(t)")
        }
        #expect(Endpoint.endsOpen("Qual foi o pacote,"))
        #expect(!Endpoint.endsOpen("Abre a agenda."))
    }

    @Test func fraseSemPontuacaoOuAbertaFicaRetida() {
        #expect(Endpoint.shouldHold("Manda um agente"))
        #expect(Endpoint.shouldHold("E de preferência de uma"))
        #expect(Endpoint.shouldHold("E de preferência de uma."))  // ponto cedo após palavra aberta
        #expect(Endpoint.shouldHold("Manda um agente,"))
        #expect(!Endpoint.shouldHold("Abre a agenda de amanhã."))
        #expect(!Endpoint.shouldHold("Que horas são?"))
    }

    @Test func juntaDentroDaJanela() {
        #expect(Endpoint.shouldMerge(previous: "Manda um agente", gap: 0.8, window: 1.5))
        #expect(Endpoint.shouldMerge(previous: "E de preferência de uma", gap: 1.2, window: 1.5))
        #expect(!Endpoint.shouldMerge(previous: "Manda um agente", gap: 1.6, window: 1.5))
        #expect(!Endpoint.shouldMerge(previous: "Abre a agenda.", gap: 0.5, window: 1.5))
    }

    @Test func descartaSoPontuacao() {
        #expect(!Endpoint.hasLetters("."))
        #expect(!Endpoint.hasLetters(" . "))
        #expect(!Endpoint.hasLetters(""))
        #expect(Endpoint.hasLetters("Sim."))
    }

    @Test func decideContinuaFechandoPorSilencio() {
        let c = EndpointConfig(silence: 1.0, openSilence: 2.2)
        #expect(Endpoint.decide(text: "Manda um agente", volatile: false, silence: 1.1, sinceText: 1, sinceFinalize: 0.1, elapsed: 5, config: c) == .close("silêncio"))
        #expect(Endpoint.decide(text: "E de preferência de uma", volatile: false, silence: 1.5, sinceText: 1, sinceFinalize: 0.1, elapsed: 5, config: c) == .wait)
        #expect(Endpoint.decide(text: "E de preferência de uma", volatile: false, silence: 2.3, sinceText: 1, sinceFinalize: 0.1, elapsed: 5, config: c) == .close("silêncio após frase aberta"))
    }
}

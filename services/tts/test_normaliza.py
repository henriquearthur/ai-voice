"""Testes da normalização de texto do TTS. Rode: python3 -m unittest services/tts/test_normaliza.py"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from normaliza import normalizar  # noqa: E402


class ExemplosObrigatorios(unittest.TestCase):
    def test_screaming_case_vira_palavras(self):
        self.assertEqual(normalizar("DATABASE_URL"), "database u erre ele")

    def test_ponto_em_nome_de_arquivo(self):
        self.assertEqual(normalizar("package.json"), "package ponto jêison")

    def test_pytest(self):
        self.assertEqual(normalizar("pytest"), "pai test")
        self.assertEqual(normalizar("Pytest"), "pai test")

    def test_ci_e_pr(self):
        self.assertEqual(normalizar("CI"), "cê i")
        self.assertEqual(normalizar("PR"), "pê érre")


class Identificadores(unittest.TestCase):
    def test_snake_case(self):
        self.assertEqual(normalizar("max_chunk_size"), "max chunk size")

    def test_screaming_case_sem_sigla(self):
        self.assertEqual(normalizar("HF_HUB_OFFLINE"), "hf hub offline")

    def test_screaming_case_com_varias_siglas(self):
        self.assertEqual(normalizar("OTEL_API_URL"), "otel a pê i u erre ele")

    def test_sublinhado_inicial(self):
        self.assertEqual(normalizar("__init__"), "init")

    def test_arquivo_com_identificador(self):
        self.assertEqual(normalizar("test_normaliza.py"), "test normaliza ponto pai")

    def test_arquivo_oculto(self):
        self.assertEqual(normalizar(".env"), "ponto énvi")

    def test_dominio(self):
        self.assertEqual(normalizar("github.com"), "guit rãb ponto com")

    def test_hifen_preservado(self):
        self.assertEqual(normalizar("jarvis-fala"), "jarvis-fala")
        self.assertEqual(normalizar("guarda-chuva"), "guarda-chuva")


class Siglas(unittest.TestCase):
    def test_siglas_comuns(self):
        self.assertEqual(normalizar("API"), "a pê i")
        self.assertEqual(normalizar("URL"), "u erre ele")
        self.assertEqual(normalizar("JSON"), "jêison")
        self.assertEqual(normalizar("CLI"), "cê ele i")
        self.assertEqual(normalizar("HTTP"), "agá tê tê pê")

    def test_plural(self):
        self.assertEqual(normalizar("os PRs"), "os pê érres")

    def test_sigla_so_em_maiusculas(self):
        # "ci" e "pr" minúsculos não são siglas.
        self.assertEqual(normalizar("ci pr"), "ci pr")

    def test_sigla_desconhecida_fica(self):
        self.assertEqual(normalizar("o XPTO saiu"), "o XPTO saiu")


class FrasesNormais(unittest.TestCase):
    def test_frase_comum_intacta(self):
        frase = "Olá, Fernando! Tudo certo por aqui; amanhã às 9h a reunião começa."
        self.assertEqual(normalizar(frase), frase)

    def test_numeros_intactos(self):
        self.assertEqual(normalizar("Custa 3.14 ou 1.000 reais, versão v1.2.3."), "Custa 3.14 ou 1.000 reais, versão v1.2.3.")

    def test_ponto_final_de_frase(self):
        self.assertEqual(normalizar("Terminei. Próximo passo."), "Terminei. Próximo passo.")
        self.assertEqual(normalizar("mudou o package.json."), "mudou o package ponto jêison.")

    def test_reticencias_e_interrogacao(self):
        self.assertEqual(normalizar("Será... que o CI passou?"), "Será... que o cê i passou?")

    def test_frase_tecnica_completa(self):
        self.assertEqual(
            normalizar("teste: o PR do CI mudou o package.json"),
            "teste: o pê érre do cê i mudou o package ponto jêison",
        )

    def test_vazio(self):
        self.assertEqual(normalizar(""), "")


if __name__ == "__main__":
    unittest.main()

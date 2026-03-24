const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const CONFIG = {
  ZAPI_INSTANCE: process.env.ZAPI_INSTANCE || "3F09E66329E771C9D7640E66E5C344E0",
  ZAPI_TOKEN: process.env.ZAPI_TOKEN || "832B64C2628C0BAA5C90DC0E",
  ZAPI_URL: "https://api.z-api.io/instances",
  ANTHROPIC_KEY: process.env.ANTHROPIC_KEY || "SUA_CHAVE_ANTHROPIC",
  PIX_KEY: process.env.PIX_KEY || "SUA_CHAVE_PIX",
  NUMERO_HUMANO: process.env.NUMERO_HUMANO || "5585999999999",
};

const estados = new Map();

function getEstado(phone) {
  return estados.get(phone) || { etapa: "novo", nome: "", ocasiao: "" };
}

function setEstado(phone, dados) {
  estados.set(phone, { ...getEstado(phone), ...dados });
}

const SYSTEM_PROMPT = `Você é a Sofia, atendente virtual de um serviço de fotos profissionais com IA.

SOBRE O SERVIÇO:
- Fazemos fotos profissionais usando inteligência artificial
- O cliente nos envia fotos simples e nós transformamos em fotos profissionais incríveis
- Entrega em até 3 dias úteis

PACOTES:
- STARTER: R$ 29,90 → 3 fotos, 1 cenário
- POPULAR: R$ 49,90 → 7 fotos, 3 cenários (MAIS VENDIDO ⭐)
- PREMIUM: R$ 89,90 → 15 fotos, 5 cenários + retoque especial
- CASAL: R$ 99,90 → 10 fotos, 3 cenários (para casais)

CENÁRIOS: LinkedIn/Profissional, Formatura, Aniversário, Casual, Natureza, Urbano, Estúdio clean, Natal, Casal e outros

COMO FUNCIONA:
1. Cliente escolhe o pacote e paga via Pix
2. Nos envia de 5 a 10 fotos com boa iluminação
3. Processamos com IA
4. Em até 3 dias recebe as fotos

REGRAS:
- Seja calorosa, empática, use emojis com moderação
- Sempre direcione para o pacote POPULAR
- Objeção "tá caro": compare com fotógrafo real (R$ 300+), sugira Starter
- Objeção "vou pensar": crie urgência gentil
- Objeção "funciona mesmo?": diga que vai mandar exemplos
- Se situação complexa: diga "Deixa eu chamar minha colega pra te ajudar melhor! Um momento 💜"
- NUNCA confirme pagamento (só o humano confirma)
- NUNCA envie link de entrega (só o humano envia)

PIX: ${CONFIG.PIX_KEY}`;

async function chamarIA(phone, mensagemCliente) {
  const estado = getEstado(phone);
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Etapa: ${estado.etapa} | Nome: ${estado.nome || "?"} | Mensagem: ${mensagemCliente}`
      }],
    },
    {
      headers: {
        "x-api-key": CONFIG.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );
  return response.data.content[0].text;
}

async function enviarMensagem(phone, texto) {
  await axios.post(
    `${CONFIG.ZAPI_URL}/${CONFIG.ZAPI_INSTANCE}/token/${CONFIG.ZAPI_TOKEN}/send-text`,
    { phone, message: texto },
    { headers: { "Content-Type": "application/json" } }
  );
}

async function alertarHumano(phone, nome, motivo) {
  const msg = `🚨 *ATENÇÃO — Cliente precisa de você*\n\n👤 ${nome || phone}\n📱 ${phone}\n📌 ${motivo}\n\nAssuma o atendimento! 💜`;
  try { await enviarMensagem(CONFIG.NUMERO_HUMANO, msg); } catch (e) {}
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body?.fromMe) return;

    const phone = body?.phone?.replace(/[^0-9]/g, "") || "";
    const mensagem = body?.text?.message || body?.message || "";
    const nome = body?.senderName || "";

    if (!phone || !mensagem) return;
    console.log(`📩 [${phone}] ${nome}: ${mensagem}`);
    if (nome) setEstado(phone, { nome });

    const gatilhos = ["gerente","responsável","falar com pessoa","atendente","humano","reclamação","reembolso","devolução"];
    if (gatilhos.some(g => mensagem.toLowerCase().includes(g))) {
      await enviarMensagem(phone, "Deixa eu chamar minha colega! Um momentinho 💜");
      await alertarHumano(phone, nome, `Cliente pediu: "${mensagem}"`);
      setEstado(phone, { etapa: "humano" });
      return;
    }

    const estado = getEstado(phone);
    if (estado.etapa === "humano") return;

    if (estado.etapa === "aguardando_pagamento" &&
      ["paguei","fiz o pix","transferi","comprovante"].some(p => mensagem.toLowerCase().includes(p))) {
      await enviarMensagem(phone, "Recebi! Confirmando o pagamento agora ⏳");
      await alertarHumano(phone, nome, "Cliente disse que pagou — confirme!");
      return;
    }

    const resposta = await chamarIA(phone, mensagem);

    if (resposta.toLowerCase().includes("chamar minha colega")) {
      await alertarHumano(phone, nome, "IA identificou situação complexa");
      setEstado(phone, { etapa: "humano" });
    }

    if (resposta.includes(CONFIG.PIX_KEY)) {
      setEstado(phone, { etapa: "aguardando_pagamento" });
    }

    await enviarMensagem(phone, resposta);
    console.log(`✅ [${phone}] OK`);
  } catch (err) {
    console.error("Erro:", err.message);
  }
});

app.post("/reativar-bot", (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ erro: "phone obrigatório" });
  setEstado(phone, { etapa: "novo" });
  res.json({ ok: true });
});

app.get("/", (req, res) => res.send("Sofia online! ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));

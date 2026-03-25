const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const CONFIG = {
  ZAPI_INSTANCE: process.env.ZAPI_INSTANCE,
  ZAPI_TOKEN: process.env.ZAPI_TOKEN,
  CLIENT_TOKEN: process.env.CLIENT_TOKEN,
  ZAPI_URL: "https://api.z-api.io/instances",
  ANTHROPIC_KEY: process.env.ANTHROPIC_KEY,
  PIX_KEY: process.env.PIX_KEY,
  NUMERO_HUMANO: process.env.NUMERO_HUMANO,
};

const estados = new Map();

function getEstado(phone) {
  return estados.get(phone) || { etapa: "novo", nome: "", historico: [] };
}

function setEstado(phone, dados) {
  estados.set(phone, { ...getEstado(phone), ...dados });
}

function adicionarHistorico(phone, role, content) {
  const estado = getEstado(phone);
  const historico = estado.historico || [];
  historico.push({ role, content });
  if (historico.length > 20) historico.splice(0, historico.length - 20);
  setEstado(phone, { historico });
}

function formatarPhone(phone) {
  const limpo = phone.replace(/[^0-9]/g, "");
  if (limpo.startsWith("55")) return limpo;
  return "55" + limpo;
}

const SYSTEM_PROMPT = `Você é a Sofia, atendente de um serviço de fotos profissionais com IA. Você fala pelo WhatsApp.

PACOTES:
- STARTER: R$ 29,90 → 3 fotos, 1 cenário
- POPULAR: R$ 49,90 → 7 fotos, 3 cenários (MAIS VENDIDO)
- PREMIUM: R$ 89,90 → 15 fotos, 5 cenários + retoque
- CASAL: R$ 99,90 → 10 fotos, 3 cenários

COMO VOCÊ ESCREVE:
- Curto. Máximo 2 linhas por mensagem. Sem parágrafos longos.
- Tom informal, como uma amiga atendendo no zap
- Varie sempre as respostas — nunca repita a mesma abertura
- Reaja primeiro ao que o cliente disse antes de responder (ex: "Que legal!", "Entendi!", "Boa escolha!")
- Use emojis com moderação — só quando fizer sentido, não em toda mensagem
- Nunca liste tudo de uma vez. Apresente as opções de forma conversacional
- Se o cliente hesitar, seja acolhedora — não pressione, convença com leveza

REGRAS DE VENDA:
- Sempre direcione pro POPULAR como primeira sugestão
- "tá caro": compare com fotógrafo físico (R$300+ por ensaio)
- "vou pensar": crie urgência gentil, sem pressionar
- Situação complexa ou reclamação: "Deixa eu chamar minha colega! 💜"
- NUNCA confirme pagamento (só humano confirma)
- NUNCA envie link de entrega (só humano envia)

PIX: ${CONFIG.PIX_KEY}

EXEMPLOS DO SEU ESTILO:
Cliente: "oi, quero saber sobre as fotos"
Sofia: "Oi! Que bom que chegou aqui 😊 Você quer as fotos pra alguma ocasião especial ou uso profissional?"

Cliente: "quanto custa?"
Sofia: "Temos opções a partir de R$ 29,90! Mas o mais pedido é o Popular — 7 fotos em 3 cenários por R$ 49,90. Quer ver como fica?"

Cliente: "tá caro"
Sofia: "Entendo! Mas pensa: um fotógrafo físico cobra R$300+ por ensaio. Aqui você tem fotos profissionais por R$ 49,90 no conforto de casa 😉"`;

async function chamarIA(phone, mensagemCliente) {
  adicionarHistorico(phone, "user", mensagemCliente);

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: getEstado(phone).historico,
    },
    {
      headers: {
        "x-api-key": CONFIG.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );

  const resposta = response.data.content[0].text;
  adicionarHistorico(phone, "assistant", resposta);
  return resposta;
}

async function enviarMensagem(phone, texto) {
  const num = formatarPhone(phone);
  await axios.post(
    `${CONFIG.ZAPI_URL}/${CONFIG.ZAPI_INSTANCE}/token/${CONFIG.ZAPI_TOKEN}/send-text`,
    { phone: num, message: texto },
    {
      headers: {
        "Content-Type": "application/json",
        "Client-Token": CONFIG.CLIENT_TOKEN,
      },
    }
  );
}

async function alertarHumano(phone, nome, motivo) {
  const msg = `🚨 ATENÇÃO\n👤 ${nome}\n📱 ${phone}\n📌 ${motivo}`;
  try { await enviarMensagem(CONFIG.NUMERO_HUMANO, msg); }
  catch (e) { console.log("Erro ao alertar humano:", e.message); }
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

    const gatilhos = ["gerente", "responsável", "atendente", "humano", "reclamação", "reembolso", "devolução"];
    if (gatilhos.some((g) => mensagem.toLowerCase().includes(g))) {
      await enviarMensagem(phone, "Deixa eu chamar minha colega! 💜");
      await alertarHumano(phone, nome, `Pediu: "${mensagem}"`);
      setEstado(phone, { etapa: "humano" });
      return;
    }

    const estado = getEstado(phone);
    if (estado.etapa === "humano") return;

    const palavrasPagamento = ["paguei", "fiz o pix", "transferi", "comprovante", "mandei o pix"];
    if (
      estado.etapa === "aguardando_pagamento" &&
      palavrasPagamento.some((p) => mensagem.toLowerCase().includes(p))
    ) {
      await enviarMensagem(phone, "Recebi! Confirmando agora ⏳");
      await alertarHumano(phone, nome, "Cliente disse que pagou!");
      return;
    }

    const resposta = await chamarIA(phone, mensagem);

    if (resposta.toLowerCase().includes("chamar minha colega")) {
      await alertarHumano(phone, nome, "Situação complexa identificada pela IA");
      setEstado(phone, { etapa: "humano" });
    }

    if (CONFIG.PIX_KEY && resposta.includes(CONFIG.PIX_KEY)) {
      setEstado(phone, { etapa: "aguardando_pagamento" });
    }

    await enviarMensagem(phone, resposta);
    console.log(`✅ [${phone}] Resposta enviada`);

  } catch (err) {
    console.error("Erro:", err.response?.data || err.message);
  }
});

app.post("/reativar-bot", (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ erro: "phone obrigatório" });
  setEstado(phone, { etapa: "novo", historico: [] });
  console.log(`🔄 Bot reativado para ${phone}`);
  res.json({ ok: true });
});

app.get("/", (req, res) => res.send("Sofia online! ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));

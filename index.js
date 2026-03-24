const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ============================================================
// CONFIGURAÇÕES — edite aqui
// ============================================================
const CONFIG = {
  EVOLUTION_URL: process.env.EVOLUTION_URL || "https://SUA_EVOLUTION_URL",
  EVOLUTION_KEY: process.env.EVOLUTION_KEY || "SUA_API_KEY",
  INSTANCE: process.env.INSTANCE || "NOME_DA_INSTANCIA",
  ANTHROPIC_KEY: process.env.ANTHROPIC_KEY || "SUA_CHAVE_ANTHROPIC",
  PIX_KEY: process.env.PIX_KEY || "SUA_CHAVE_PIX",
  NUMERO_HUMANO: process.env.NUMERO_HUMANO || "5585999999999", // número da sua namorada para receber alertas
};

// ============================================================
// ESTADO EM MEMÓRIA (reinicia se o servidor reiniciar — ok pro MVP)
// ============================================================
const estados = new Map();

function getEstado(phone) {
  return estados.get(phone) || { etapa: "novo", nome: "", ocasiao: "", pacote: "" };
}

function setEstado(phone, dados) {
  estados.set(phone, { ...getEstado(phone), ...dados });
}

// ============================================================
// SISTEMA DO BOT — prompt principal
// ============================================================
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

CENÁRIOS DISPONÍVEIS:
LinkedIn/Profissional, Formatura, Aniversário, Casual, Natureza, Urbano, Estúdio clean, Natal, Casal e outros

COMO FUNCIONA:
1. Cliente escolhe o pacote e paga via Pix
2. Nos envia de 5 a 10 fotos (boa iluminação)
3. Processamos com IA
4. Em até 3 dias recebe as fotos pelo WhatsApp

REGRAS DE COMPORTAMENTO:
- Seja calorosa, empática, use emojis com moderação
- Sempre tente direcionar para o pacote POPULAR (melhor custo-benefício)
- Se perguntarem "como funciona", explique o processo de forma simples
- Nunca invente preços ou cenários que não estão listados
- Objeção "tá caro": compare com fotógrafo real (R$ 300+), sugira o Starter como entrada
- Objeção "vou pensar": crie urgência gentil, fale que os preços podem aumentar em breve
- Objeção "funciona mesmo?": peça para aguardar que vai mandar exemplos (o humano envia depois)
- Se a conversa ficar muito complexa, emocional ou fora do script, diga: "Deixa eu chamar minha colega pra te ajudar melhor! Um momento 💜"
- NUNCA confirme pagamento recebido (só o humano confirma)
- NUNCA envie link de entrega (só o humano envia)

FLUXO ESPERADO:
1. Boas-vindas → pergunta a ocasião
2. Apresenta o pacote ideal para a ocasião
3. Responde dúvidas → fecha com Pix
4. Aguarda confirmação de pagamento (humano assume aqui)
5. Solicita fotos do cliente → instrui como tirar

PIX PARA PAGAMENTO: ${CONFIG.PIX_KEY}`;

// ============================================================
// FUNÇÃO: chama Claude (IA)
// ============================================================
async function chamarIA(phone, mensagemCliente) {
  const estado = getEstado(phone);

  // Monta histórico simples (só última troca por enquanto — MVP)
  const messages = [
    {
      role: "user",
      content: `[Contexto interno - não mostrar ao cliente]
Etapa atual: ${estado.etapa}
Nome do cliente: ${estado.nome || "desconhecido"}
Ocasião informada: ${estado.ocasiao || "não informada"}
Pacote de interesse: ${estado.pacote || "nenhum ainda"}

Mensagem do cliente: ${mensagemCliente}`,
    },
  ];

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages,
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

// ============================================================
// FUNÇÃO: envia mensagem via Evolution API
// ============================================================
async function enviarMensagem(phone, texto) {
  await axios.post(
    `${CONFIG.EVOLUTION_URL}/message/sendText/${CONFIG.INSTANCE}`,
    { number: phone, text: texto },
    { headers: { apikey: CONFIG.EVOLUTION_KEY } }
  );
}

// ============================================================
// FUNÇÃO: alerta para o humano
// ============================================================
async function alertarHumano(phone, nome, motivo) {
  const msg = `🚨 *ATENÇÃO — Cliente precisa de você*

👤 Cliente: ${nome || phone}
📱 Número: ${phone}
📌 Motivo: ${motivo}

Entre no chat e assuma o atendimento! 💜`;

  try {
    await enviarMensagem(CONFIG.NUMERO_HUMANO, msg);
  } catch (e) {
    console.log("Erro ao alertar humano:", e.message);
  }
}

// ============================================================
// WEBHOOK PRINCIPAL
// ============================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // responde rápido para a Evolution não reenviar

  try {
    const body = req.body;

    // Extrai dados da mensagem
    const fromMe = body?.data?.key?.fromMe;
    if (fromMe) return; // ignora mensagens enviadas pelo bot

    const phone =
      body?.data?.key?.remoteJid?.replace("@s.whatsapp.net", "") || "";
    const mensagem =
      body?.data?.message?.conversation ||
      body?.data?.message?.extendedTextMessage?.text ||
      "";
    const nome = body?.data?.pushName || "";

    if (!phone || !mensagem) return;

    console.log(`📩 [${phone}] ${nome}: ${mensagem}`);

    // Atualiza nome se tiver
    if (nome) setEstado(phone, { nome });

    // Detecta palavras que indicam objeção complexa → chama humano
    const gatilhosHumano = [
      "gerente",
      "responsável",
      "falar com pessoa",
      "atendente",
      "humano",
      "reclamação",
      "reembolso",
      "devolução",
      "errado",
      "péssimo",
      "horrível",
    ];

    const precisaHumano = gatilhosHumano.some((g) =>
      mensagem.toLowerCase().includes(g)
    );

    if (precisaHumano) {
      await enviarMensagem(
        phone,
        "Entendido! Deixa eu chamar minha colega que vai te ajudar melhor. Um momentinho! 💜"
      );
      await alertarHumano(phone, nome, `Cliente pediu: "${mensagem}"`);
      setEstado(phone, { etapa: "humano" });
      return;
    }

    // Se etapa for "humano", não responde automaticamente
    const estado = getEstado(phone);
    if (estado.etapa === "humano") {
      console.log(`⏸️ [${phone}] Em atendimento humano — bot pausado`);
      return;
    }

    // Detecta se está aguardando pagamento (humano confirma)
    if (
      estado.etapa === "aguardando_pagamento" &&
      (mensagem.toLowerCase().includes("paguei") ||
        mensagem.toLowerCase().includes("fiz o pix") ||
        mensagem.toLowerCase().includes("transferi") ||
        mensagem.toLowerCase().includes("comprovante"))
    ) {
      await enviarMensagem(
        phone,
        "Recebi! Estou confirmando o pagamento agora. Um minutinho! ⏳"
      );
      await alertarHumano(
        phone,
        nome,
        "Cliente disse que pagou — confirme o comprovante e libere!"
      );
      return;
    }

    // IA responde
    const resposta = await chamarIA(phone, mensagem);

    // Detecta se a IA pediu para chamar humano
    if (
      resposta.toLowerCase().includes("chamar minha colega") ||
      resposta.toLowerCase().includes("chamar minha assistente")
    ) {
      await alertarHumano(
        phone,
        nome,
        "IA identificou situação complexa — objeção ou dúvida fora do script"
      );
      setEstado(phone, { etapa: "humano" });
    }

    // Detecta etapa pelo conteúdo da resposta (heurística simples)
    if (resposta.toLowerCase().includes("pix") && resposta.includes(CONFIG.PIX_KEY)) {
      setEstado(phone, { etapa: "aguardando_pagamento" });
    }

    await enviarMensagem(phone, resposta);
    console.log(`✅ [${phone}] Resposta enviada`);
  } catch (err) {
    console.error("Erro no webhook:", err.message);
  }
});

// Endpoint para o humano reativar o bot manualmente
// POST /reativar-bot  { "phone": "5585999999999" }
app.post("/reativar-bot", (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ erro: "phone obrigatório" });
  setEstado(phone, { etapa: "novo" });
  console.log(`🔄 Bot reativado para ${phone}`);
  res.json({ ok: true, mensagem: `Bot reativado para ${phone}` });
});

// Health check
app.get("/", (req, res) => res.send("Bot rodando! ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));

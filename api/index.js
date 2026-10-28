// API de busca de produtos por imagem
// Recebe a foto de um ambiente + descrição, usa um LLM com visão para gerar
// buscas detalhadas e retorna produtos do Google Shopping (via SerpApi).

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const OpenAI = require('openai');
const { getJson } = require('serpapi');
require('dotenv').config();

// --- Configuração dos Clientes ---
const serpApiKey = process.env.SERPAPI_API_KEY;
if (!process.env.OPENAI_API_KEY || !serpApiKey) {
  console.error('Defina OPENAI_API_KEY e SERPAPI_API_KEY no arquivo .env (veja .env.example).');
  process.exit(1);
}
const openai = new OpenAI();

// --- Configuração do Servidor Express ---
const app = express();
const port = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

// --- Configuração do Multer ('memoryStorage') ---
const storage = multer.memoryStorage();
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB
const upload = multer({ storage: storage, limits: { fileSize: MAX_IMAGE_SIZE } });

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ###############################################################
// ### O ENDPOINT COM O PROMPT "ENRIQUECEDOR" ###
// ###############################################################
app.post('/api/process-image', upload.single('image'), async (req, res) => {
  console.log('Recebendo dados (imagem + texto)...');

  try {
    // 1. Coletar inputs
    const imageFile = req.file;
    const description = req.body.description; // "sofá branco"
    const dimensions = req.body.dimensions || "";

    if (!imageFile || !description) {
      return res.status(400).json({ error: 'Imagem e descrição são obrigatórias.' });
    }
    if (!imageFile.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: 'O arquivo enviado precisa ser uma imagem.' });
    }

    // 2. Preparar imagem para a OpenAI
    const base64Image = imageFile.buffer.toString('base64');
    const mimeType = imageFile.mimetype;

    // -----------------------------------------------------------------
    // --- ETAPA 1: IA DE ANÁLISE (OpenAI) ---
    // -----------------------------------------------------------------
    //
    // ### AQUI ESTÁ A MUDANÇA: PROMPT "ENRIQUECEDOR" ###
    //
    const prompt_etapa_1 = `
      Você é um assistente de busca especialista em design de interiores.

      O usuário fornece:
      1. IMAGEM DO AMBIENTE: (anexada)
      2. CAMPO "O QUE PROCURAR?": "${description}"
      3. CAMPO "DETALHES": "${dimensions}"

      **SUA TAREFA PRINCIPAL É ENRIQUECER O PEDIDO DO USUÁRIO.**
      O texto do usuário é apenas o *ponto de partida*. Sua principal função é usar a IMAGEM para adicionar detalhes visuais cruciais (estilo, material, forma, textura) que o usuário não digitou.

      **SEU PROCESSO MENTAL OBRIGATÓRIO:**

      **PASSO 1: IDENTIFICAR O SUJEITO DA BUSCA.**
      Leia o campo "O QUE PROCURAR?" para identificar o(s) item(ns) principal(is).
      - Exemplo: Se o usuário digitou "sofá branco", o sujeito é "sofá".
      - Exemplo: Se o usuário digitou "quadro e poltrona", os sujeitos são "quadro" e "poltrona".
      (Se o usuário digitar uma frase longa, identifique o sujeito principal, como "sofá").

      **PASSO 2: COLETAR TODOS OS DESCRITORES (DE TODAS AS FONTES).**
      Para cada Sujeito, crie uma lista de características:
      - **Fonte A (Texto do Usuário):** Colete os adjetivos do campo "O QUE PROCURAR?" (ex: "branco", "moderno").
      - **Fonte B (Detalhes do Usuário):** Colete os adjetivos do campo "DETALHES" (ex: "linho", "2 peças").
      - **Fonte C (Análise Visual da Imagem):** Esta é a sua contribuição mais importante. Olhe a imagem, encontre o Sujeito e adicione todos os detalhes visuais que você vê (ex: "pés de madeira", "estilo minimalista", "almofadas soltas", "tecido texturizado").

      **PASSO 3: SINTETIZAR A QUERY FINAL.**
      Combine o Sujeito (do Passo 1) com a lista completa de descritores (do Passo 2, Fontes A, B e C) para formar uma única query de busca longa e hiper-específica.
      - **Exemplo de Processo:**
        - Sujeito: "sofá"
        - Fonte A: "branco"
        - Fonte B: (vazio)
        - Fonte C (Imagem): "de linho", "pés de madeira clara", "estilo escandinavo", "3 lugares"
        - **Query Final:** "sofá branco de linho 3 lugares com pés de madeira clara estilo escandinavo"

      **PASSO 4: SAÍDA.**
      Retorne *apenas* um objeto JSON com as queries finais.
      {
        "queries": ["aqui vai a query final enriquecida e hiper-específica"]
      }
    `;

    console.log('Etapa 1: Enviando para OpenAI (Prompt Enriquecedor)...');
    const openAIResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt_etapa_1 },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
          ],
        },
      ],
      max_tokens: 1000,
    });

    const resultObject = JSON.parse(openAIResponse.choices[0].message.content);
    const searchQueries = resultObject.queries || [];
    console.log('Termos de busca (Enriquecidos) gerados:', searchQueries);

    if (searchQueries.length === 0) {
      return res.json({}); 
    }

    // -----------------------------------------------------------------
    // --- ETAPA 2: IA DE BUSCA (SerpApi - Google Shopping) ---
    // -----------------------------------------------------------------
    const finalResults = {};

    await Promise.all(
      searchQueries.map(async (query) => {
        console.log(`Etapa 2: Buscando por "${query}" no Google Shopping...`);
        
        try {
          const params = {
            api_key: serpApiKey,
            engine: 'google_shopping',
            q: query, 
            location: 'Brazil',
            hl: 'pt-br',
            gl: 'br',
            num: 10
          };

          const serpApiData = await getJson(params);
          const shoppingResults = serpApiData.shopping_results || [];

          const formattedResults = shoppingResults.slice(0, 10).map(item => ({
            name: item.title,
            price: item.price,
            link: item.product_link || item.link, 
            store: item.source, 
          }));

          finalResults[query] = formattedResults;

        } catch (error) {
          console.error(`Erro ao buscar na SerpApi para a query "${query}":`, error.message);
          finalResults[query] = [];
        }
      })
    );
    
    console.log("Enviando resultados do Google Shopping para o frontend.");
    res.json(finalResults);

  } catch (error) {
    console.error('--- ERRO DETALHADO ---');
    console.error(error); 
    console.error('--- FIM DO ERRO ---');
    const errorMessage = error ? (error.message || 'Erro desconhecido') : 'Erro desconhecido';
    console.error('Erro geral no processamento:', errorMessage);
      
    res.status(500).json({ error: 'Erro ao processar a requisição.' });
  }
});

// Erros do upload (ex.: imagem acima do limite)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'A imagem deve ter no máximo 5 MB.' : err.message;
    return res.status(400).json({ error: message });
  }
  next(err);
});

// Exporta o app (Vercel) e sobe o servidor quando executado diretamente (local)
module.exports = app;

if (require.main === module) {
  app.listen(port, () => {
    console.log(`API rodando em http://localhost:${port}`);
  });
}

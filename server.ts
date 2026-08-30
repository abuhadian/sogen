import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const app = express();
const PORT = 3000;

// Body parser with large limit for PDF base64 payloads (up to 20MB)
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Initialize Google GenAI client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// API Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasApiKey: !!process.env.GEMINI_API_KEY,
    timestamp: Date.now(),
  });
});

// API endpoint to generate quiz questions from PDF / Text
app.post('/api/generate-quiz', async (req, res) => {
  try {
    const {
      pdfBase64,
      pdfMimeType = 'application/pdf',
      textContent,
      fileName = 'Dokumen.pdf',
      numQuestions = 5,
      questionType = 'multiple_choice',
      difficulty = 'mixed',
      language = 'id',
      focusTopic = '',
    } = req.body;

    const count = Math.min(Math.max(parseInt(numQuestions) || 5, 2), 25);

    // If no API key is provided, return structured error or handle gracefully
    if (!process.env.GEMINI_API_KEY) {
      return res.status(400).json({
        error: 'GEMINI_API_KEY is not configured in the environment. Please check Settings > Secrets.',
      });
    }

    let typePrompt = 'Buat soal pilihan ganda dengan 4 opsi pilihan jawaban (A, B, C, D) yang jelas dan realistis.';
    if (questionType === 'true_false') {
      typePrompt = 'Buat soal bertipe Benar/Salah (True/False) dengan tepat 2 opsi: "Benar" dan "Salah".';
    } else if (questionType === 'mixed') {
      typePrompt = 'Buat kombinasi soal pilihan ganda (4 opsi) dan beberapa soal Benar/Salah.';
    }

    let diffPrompt = 'Tingkat kesulitan campuran (ada soal mudah, sedang, dan analisis mendalam).';
    if (difficulty === 'easy') diffPrompt = 'Tingkat kesulitan: Mudah (pertanyaan dasar, definisi, dan fakta langsung).';
    if (difficulty === 'medium') diffPrompt = 'Tingkat kesulitan: Sedang (pemahaman konsep dan aplikasi materi).';
    if (difficulty === 'hard') diffPrompt = 'Tingkat kesulitan: Sulit (analisis kritis, evaluasi kasus, dan pemecahan masalah mendalam).';

    const langPrompt = language === 'en' ? 'Use English for all questions and explanations.' : 'Gunakan Bahasa Indonesia yang baku, jelas, dan edukatif.';
    const topicPrompt = focusTopic ? `Fokus khusus pada topik/bab: "${focusTopic}".` : '';

    const systemPrompt = `Anda adalah seorang ahli pembuat soal ujian akademik, dosen, dan evaluator pendidikan profesional.
Tugas Anda adalah membaca dan menganalisis dokumen PDF / materi pelajaran yang diberikan, kemudian membuat ${count} butir soal ujian berkualitas tinggi berdasarkan isi dokumen tersebut.

Petunjuk Pembuatan Soal:
1. Soal HARUS bersumber langsung dari fakta, konsep, definisi, rumus, atau data yang terdapat di dalam materi dokumen.
2. ${typePrompt}
3. ${diffPrompt}
4. ${langPrompt}
5. ${topicPrompt}
6. Setiap soal harus memiliki:
   - question: Kalimat pertanyaan yang jelas dan tidak ambigu.
   - options: Array pilihan jawaban (string). Pastikan pilihan pengecoh (distractor) masuk akal dan relevan.
   - correctAnswerIndex: Index (angka 0, 1, 2, atau 3) dari pilihan yang benar dalam array options.
   - correctAnswerText: Teks lengkap dari jawaban yang benar.
   - explanation: Penjelasan edukatif yang rinci mengapa jawaban tersebut benar dan referensi kontekstual dari dokumen.
   - difficulty: "easy" | "medium" | "hard".
   - topic: Sub-topik spesifik dari soal tersebut.
   - sourceSnippet: Kutipan kalimat atau bagian ringkas dari dokumen yang menjadi dasar jawaban.`;

    const contents: any = [];

    // If PDF base64 is provided
    if (pdfBase64) {
      // Clean base64 prefix if present (e.g. data:application/pdf;base64,...)
      const cleanBase64 = pdfBase64.replace(/^data:[^;]+;base64,/, '');
      contents.push({
        parts: [
          {
            inlineData: {
              mimeType: pdfMimeType || 'application/pdf',
              data: cleanBase64,
            },
          },
          {
            text: `Berikut adalah dokumen PDF "${fileName}". Tolong buatkan ${count} butir soal ujian sesuai kriteria di atas dalam format JSON yang valid.`,
          },
        ],
      });
    } else if (textContent) {
      contents.push({
        parts: [
          {
            text: `Berikut adalah materi dokumen "${fileName}":\n\n${textContent}\n\nTolong buatkan ${count} butir soal ujian sesuai kriteria di atas dalam format JSON yang valid.`,
          },
        ],
      });
    } else {
      return res.status(400).json({ error: 'Tidak ada file PDF atau konten teks yang dikirimkan.' });
    }

    // Model selection: Try configured model or fallback through available Gemini 2.0 and 1.5 models
    const configuredModel = process.env.GEMINI_MODEL;
    const defaultModels = [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash-latest',
      'gemini-1.5-flash-002',
      'gemini-1.5-flash',
      'gemini-1.5-pro-latest',
      'gemini-1.5-pro',
    ];
    const modelsToTry = configuredModel
      ? [configuredModel, ...defaultModels.filter((m) => m !== configuredModel)]
      : defaultModels;
    let lastError: any = null;
    let responseText = '';

    for (let m = 0; m < modelsToTry.length; m++) {
      const currentModel = modelsToTry[m];

      try {
        console.log(`[Generate Quiz] Requesting model: ${currentModel}`);
        const response = await ai.models.generateContent({
          model: currentModel,
          contents: contents,
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              description: 'Daftar butir soal yang digenerate dari dokumen PDF',
              items: {
                type: Type.OBJECT,
                properties: {
                  question: {
                    type: Type.STRING,
                    description: 'Teks pertanyaan lengkap',
                  },
                  options: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Daftar pilihan jawaban',
                  },
                  correctAnswerIndex: {
                    type: Type.INTEGER,
                    description: 'Index jawaban benar pada array options (0-indexed)',
                  },
                  correctAnswerText: {
                    type: Type.STRING,
                    description: 'Teks jawaban yang benar',
                  },
                  explanation: {
                    type: Type.STRING,
                    description: 'Pembahasan lengkap dan edukatif mengenai kunci jawaban',
                  },
                  difficulty: {
                    type: Type.STRING,
                    description: 'Tingkat kesulitan: easy, medium, atau hard',
                  },
                  topic: {
                    type: Type.STRING,
                    description: 'Sub-topik materi dari soal',
                  },
                  sourceSnippet: {
                    type: Type.STRING,
                    description: 'Kutipan kalimat atau ringkasan dari PDF yang membuktikan jawaban',
                  },
                },
                required: ['question', 'options', 'correctAnswerIndex', 'explanation', 'difficulty'],
              },
            },
          },
        });

        responseText = response.text || '';
        if (responseText.trim().length > 0) {
          lastError = null;
          break;
        }
      } catch (err: any) {
        lastError = err;
        const errMsg = err?.message || String(err);
        console.warn(`[Generate Quiz] Error on ${currentModel}:`, errMsg);
        // Continue to next fallback model immediately to stay within proxy timeout limit
      }
    }

    if (!responseText && lastError) {
      // Parse human-readable error from lastError
      let cleanErrorMessage = lastError.message || 'Terjadi kesalahan saat memproses model AI.';
      try {
        if (cleanErrorMessage.includes('{') && cleanErrorMessage.includes('}')) {
          const jsonMatch = cleanErrorMessage.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.error?.message) {
              cleanErrorMessage = parsed.error.message;
            }
          }
        }
      } catch (e) {
        // use raw cleanErrorMessage
      }

      if (cleanErrorMessage.includes('high demand') || cleanErrorMessage.includes('503') || cleanErrorMessage.includes('UNAVAILABLE')) {
        cleanErrorMessage = 'Model AI saat ini sedang mengalami lonjakan permintaan trafik sementara. Silakan tekan tombol "Coba Lagi" dalam beberapa detik.';
      } else if (cleanErrorMessage.includes('429') || cleanErrorMessage.includes('RESOURCE_EXHAUSTED')) {
        cleanErrorMessage = 'Batas kuota model AI tercapai sementara. Silakan coba lagi dalam 1-2 menit.';
      }

      return res.status(503).json({
        error: cleanErrorMessage,
      });
    }
    let parsedQuestions: any[] = [];

    try {
      parsedQuestions = JSON.parse(responseText);
    } catch (parseErr) {
      // Fallback regex json extractor
      const match = responseText.match(/\[[\s\S]*\]/);
      if (match) {
        parsedQuestions = JSON.parse(match[0]);
      } else {
        throw new Error('Gagal memproses format jawaban JSON dari AI.');
      }
    }

    // Format & validate questions
    const formattedQuestions = parsedQuestions.map((q: any, idx: number) => {
      const options = Array.isArray(q.options) && q.options.length > 0 ? q.options : ['Pilihan A', 'Pilihan B', 'Pilihan C', 'Pilihan D'];
      let correctIdx = typeof q.correctAnswerIndex === 'number' ? q.correctAnswerIndex : 0;
      if (correctIdx < 0 || correctIdx >= options.length) {
        correctIdx = 0;
      }

      return {
        id: `q_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`,
        originalIndex: idx,
        question: q.question || `Pertanyaan #${idx + 1}`,
        options: options,
        correctAnswerIndex: correctIdx,
        correctAnswerText: q.correctAnswerText || options[correctIdx] || '',
        explanation: q.explanation || 'Pembahasan kunci jawaban berdasarkan dokumen materi terkait.',
        difficulty: (['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium') as 'easy' | 'medium' | 'hard',
        topic: q.topic || 'Pemahaman Dokumen',
        sourceSnippet: q.sourceSnippet || `Referensi dari dokumen: ${fileName}`,
      };
    });

    return res.json({
      success: true,
      fileName,
      totalQuestions: formattedQuestions.length,
      questions: formattedQuestions,
    });
  } catch (error: any) {
    console.error('Error generating quiz:', error);
    return res.status(500).json({
      error: error.message || 'Terjadi kesalahan saat membuat soal dari dokumen PDF.',
    });
  }
});

// Start server function with Vite dev/prod middleware
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, host: '0.0.0.0', port: PORT },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 PDF Quiz Generator Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});

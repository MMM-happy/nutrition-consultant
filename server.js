const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 載入 .env 環境變數
if (fs.existsSync(path.join(__dirname, '.env'))) {
    dotenv.config({ path: path.join(__dirname, '.env') });
} else if (fs.existsSync(path.join(__dirname, '.env.example'))) {
    dotenv.config({ path: path.join(__dirname, '.env.example') });
} else {
    dotenv.config();
}

const app = express();
const PORT = process.env.PORT || 3000;

// 支援較大的 Base64 圖片上傳 payload
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(express.static(path.join(__dirname)));

// 通用 AI 呼叫處理函式 (支援文字與圖片多模態)
async function callGemini(apiKey, promptParts, responseJsonFormat = false) {
    const activeKey = apiKey || process.env.GEMINI_API_KEY;
    if (!activeKey || activeKey === 'YOUR_GEMINI_API_KEY_HERE') {
        throw new Error('🔑 API Key 尚未設定！請在網頁中填入您的 Gemini API Key 或設定 .env。');
    }

    const ai = new GoogleGenerativeAI(activeKey);
    const candidateModels = ['gemini-1.5-flash', 'gemini-1.5-flash-latest', 'gemini-2.0-flash', 'gemini-3.6-flash', 'gemini-pro'];

    let lastError = null;

    // 1. 先嘗試預設常用模型
    for (const m of candidateModels) {
        try {
            const modelConfig = { model: m };
            if (responseJsonFormat) {
                modelConfig.generationConfig = { responseMimeType: "application/json" };
            }
            const model = ai.getGenerativeModel(modelConfig);
            const result = await model.generateContent(promptParts);
            const res = await result.response;
            return res.text();
        } catch (err) {
            lastError = err;
        }
    }

    // 2. 動態查詢可用模型
    try {
        const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${activeKey}`);
        const listData = await listRes.json();
        
        if (listData.models && listData.models.length > 0) {
            const validModels = listData.models.filter(m => 
                m.supportedGenerationMethods && 
                m.supportedGenerationMethods.includes('generateContent') &&
                !m.name.includes('gemini-2.5-flash')
            );
            
            for (const validModel of validModels) {
                const actualName = validModel.name.replace('models/', '');
                try {
                    const modelConfig = { model: actualName };
                    if (responseJsonFormat) {
                        modelConfig.generationConfig = { responseMimeType: "application/json" };
                    }
                    const model = ai.getGenerativeModel(modelConfig);
                    const result = await model.generateContent(promptParts);
                    const res = await result.response;
                    return res.text();
                } catch (e) {
                    // continue
                }
            }
        }
    } catch (e) {
        // ignore
    }

    throw new Error(`無法連接 Gemini API。最後錯誤: ${lastError ? lastError.message : '未知錯誤'}`);
}

// ---------------------------------------------------------
// 1. 智遊秘書 AI 助理：旅遊行程生成 API
// ---------------------------------------------------------
app.post('/api/generate-plan', async (req, res) => {
    try {
        let { destination, days, travelStyle = '綜合探索', apiKey: customApiKey } = req.body;

        if (!destination || !days) {
            return res.status(400).json({ success: false, error: '請提供有效的目的地與天數！' });
        }

        const prompt = `
你是一位專業且熱情的資深旅遊規劃師「智遊秘書」。
請為使用者量身打造一份極具吸引力、豐富且詳細的 ${destination} ${days} 天旅遊行程指南。
`;

        console.log(`[智遊秘書 AI] 正在為目的地 "${destination}" 生成 ${days} 天行程...`);
        const text = await callGemini(customApiKey, [prompt], false);
        return res.json({ success: true, data: text });
    } catch (error) {
        console.error('Generate Plan Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ---------------------------------------------------------
// 2. AI 專屬營養師：自然語言飲食分析 API
// ---------------------------------------------------------
app.post('/api/parse-meal', async (req, res) => {
    try {
        const { mealInput, mealType = '午餐', apiKey } = req.body;

        if (!mealInput) {
            return res.status(400).json({ success: false, error: '請輸入您吃的飲食內容！' });
        }

        const prompt = `
你是一位精準的專業營養師與食物熱量估算專家。
使用者輸入了他吃的餐點內容：「${mealInput}」（餐別：${mealType}）。

請評估這頓餐點的營養成分，並只輸出以下 JSON 格式：
{
  "mealName": "簡明餐點名稱",
  "calories": 熱量估計值(整數kcal),
  "protein": 蛋白質估計值(整數g),
  "carbs": 碳水化合物估計值(整數g),
  "fat": 脂肪估計值(整數g),
  "tip": "一句話專業短評與建議"
}
`;

        console.log(`[AI 營養師] 正在分析文字餐點: "${mealInput}"...`);
        const jsonText = await callGemini(apiKey, [prompt], true);
        const cleanJson = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(cleanJson);

        return res.json({ success: true, data });
    } catch (error) {
        console.error('Parse Meal Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ---------------------------------------------------------
// 3. ✨【全新功能】AI 專屬營養師：食物照片 Vision 辨識分析 API
// ---------------------------------------------------------
app.post('/api/parse-food-image', async (req, res) => {
    try {
        const { imageBase64, mimeType = 'image/jpeg', mealType = '午餐', apiKey } = req.body;

        if (!imageBase64) {
            return res.status(400).json({ success: false, error: '請上傳或拍攝一張食物照片！' });
        }

        // 移除可能的 data:image/jpeg;base64, 前綴
        const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

        const prompt = `
你是一位具備視覺影像辨識能力的頂尖專業營養師與美食熱量專家。
請仔細觀察這張照片中的食物：
1. 識別出照片中的主要菜餚、食材與份量。
2. 估算出此餐點的總熱量(kcal)與三大營養素：蛋白質(g)、碳水化合物(g)、脂肪(g)。
3. 給予一句親切且具體的營養建議。

請【只輸出以下 JSON 格式】（不要包含任何額外說明文字）：
{
  "mealName": "識別出的食物名稱 (例如：煎鮭魚沙拉配水煮蛋、排骨便當)",
  "calories": 熱量估算值(整數kcal),
  "protein": 蛋白質估估值(整數g),
  "carbs": 碳水化合物估算值(整數g),
  "fat": 脂肪估算值(整數g),
  "tip": "針對照片食物的一句話專業點評"
}
`;

        const imagePart = {
            inlineData: {
                data: cleanBase64,
                mimeType: mimeType
            }
        };

        console.log(`[AI 營養師 Vision] 正在對食物照片進行 Vision 辨識與營養分析...`);
        const jsonText = await callGemini(apiKey, [prompt, imagePart], true);
        const cleanJson = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(cleanJson);

        return res.json({ success: true, data });

    } catch (error) {
        console.error('Parse Food Image Error:', error);
        return res.status(500).json({ success: false, error: error.message || '照片分析失敗，請重試或更換照片。' });
    }
});

// ---------------------------------------------------------
// 4. AI 專屬營養師：菜單推薦 API
// ---------------------------------------------------------
app.post('/api/recommend-meal', async (req, res) => {
    try {
        const { targetCalories, targetP, targetC, targetF, currentCalories, currentP, currentC, currentF, apiKey } = req.body;

        const remainingCal = Math.max(0, targetCalories - currentCalories);
        const remainingP = Math.max(0, targetP - currentP);
        const remainingC = Math.max(0, targetC - currentC);
        const remainingF = Math.max(0, targetF - currentF);

        const prompt = `
你是一位專業的個人 AI 專屬醫師兼營養顧問。
使用者今天的營養攝取進度如下：
- 每日建議總熱量目標：${targetCalories} kcal (目前已攝取 ${currentCalories} kcal，剩餘 ${remainingCal} kcal)
- 蛋白質目標：${targetP}g (目前已攝取 ${currentP}g，缺口 ${remainingP}g)
- 碳水化合物目標：${targetC}g (目前已攝取 ${currentC}g，剩餘額度 ${remainingC}g)
- 脂肪目標：${targetF}g (目前已攝取 ${currentF}g，剩餘額度 ${remainingF}g)

請根據上述「剩餘熱量與營養缺口」，特別是蛋白質缺口與碳水控制，為使用者量身規劃【3 方案推薦】下一餐：
- 方案 1：超商便利組合 (全家/7-11)
- 方案 2：外食小吃/餐廳組合
- 方案 3：自煮快速輕食組合

請使用繁體中文 Markdown 格式輸出。
`;

        console.log(`[AI 營養師] 正在生成下一餐配餐推薦...`);
        const markdownText = await callGemini(apiKey, [prompt], false);

        return res.json({ success: true, data: markdownText });
    } catch (error) {
        console.error('Recommend Meal Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`
=====================================================
🚀 雙功能 AI 系統伺服器 (含 Vision 照片辨識) 啟動成功！
✈️ 智遊秘書: http://localhost:${PORT}
🥗 AI 營養師 (支援食物拍照辨識): http://localhost:${PORT}/nutrition.html
=====================================================
    `);
});

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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// 通用 AI 呼叫處理函式 (包含自動模型偵測與降級)
async function callGemini(apiKey, prompt, responseJsonFormat = false) {
    const activeKey = apiKey || process.env.GEMINI_API_KEY;
    if (!activeKey || activeKey === 'YOUR_GEMINI_API_KEY_HERE') {
        throw new Error('🔑 API Key 尚未設定！請在網頁右上角填入您的 Gemini API Key 或設定 .env。');
    }

    const ai = new GoogleGenerativeAI(activeKey);
    const candidateModels = ['gemini-1.5-flash', 'gemini-1.5-flash-latest', 'gemini-pro', 'gemini-2.0-flash', 'gemini-3.6-flash'];

    let lastError = null;

    // 1. 先嘗試預設常用模型
    for (const m of candidateModels) {
        try {
            const modelConfig = { model: m };
            if (responseJsonFormat) {
                modelConfig.generationConfig = { responseMimeType: "application/json" };
            }
            const model = ai.getGenerativeModel(modelConfig);
            const result = await model.generateContent(prompt);
            const res = await result.response;
            return res.text();
        } catch (err) {
            lastError = err;
        }
    }

    // 2. 若預設失敗，查詢 ListModels 動態選擇可用模型
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
                    const result = await model.generateContent(prompt);
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

// 1. 自然語言飲食分析 API
app.post('/api/parse-meal', async (req, res) => {
    try {
        const { mealInput, mealType = '午餐', apiKey } = req.body;

        if (!mealInput) {
            return res.status(400).json({ success: false, error: '請輸入您吃的飲食內容！' });
        }

        const prompt = `
你是一位精準的專業營養師與食物熱量估算專家。
使用者輸入了他吃的餐點內容：「${mealInput}」（餐別：${mealType}）。

請評估這頓餐點的營養成分，並只輸出以下 JSON 格式（不要包含任何額外 Markdown 開頭）：
{
  "mealName": "簡明餐點名稱 (如：滷雞腿便當、銀絲卷配鮮奶)",
  "calories": 熱量估計值(整數kcal),
  "protein": 蛋白質估計值(整數g),
  "carbs": 碳水化合物估計值(整數g),
  "fat": 脂肪估計值(整數g),
  "tip": "一句話短評 (如：蛋白質豐富，但油脂偏高，建議下一餐多補充水分與蔬菜)"
}
`;

        const jsonText = await callGemini(apiKey, prompt, true);
        
        // 清理可能的 markdown codeblock 標籤
        const cleanJson = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(cleanJson);

        return res.json({ success: true, data });

    } catch (error) {
        console.error('Parse Meal Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// 2. AI 專屬菜單推薦 / 缺口救援 API
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

請根據上述「剩餘熱量與營養缺口」，特別是蛋白質缺口與碳水控制，為使用者量身規劃【3 方案推薦】下一餐（例如晚餐或補給）：
方案 1：超商便利組合 (全家/7-11 隨手可買)
方案 2：外食小吃/餐廳組合 (便當店、火鍋或路邊攤)
方案 3：自煮快速輕食組合

請使用繁體中文 Markdown 格式輸出，語氣親切專業且具體（附上估算熱量與 P/C/F）。包含標題、重點提示與分析。
`;

        const markdownText = await callGemini(apiKey, prompt, false);
        return res.json({ success: true, data: markdownText });

    } catch (error) {
        console.error('Recommend Meal Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`
=====================================================
🥗 AI 專屬營養師助理伺服器已成功啟動！
🌐 網站位址: http://localhost:${PORT}/nutrition.html
=====================================================
    `);
});

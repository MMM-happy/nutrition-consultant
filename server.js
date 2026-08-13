const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 載入 .env 環境變數
if (fs.existsSync(path.join(__dirname, '.env'))) {
    dotenv.config({ path: path.join(__dirname, '.env') });
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

const DEFAULT_PROFILES = [
    { id: 'u_1', name: '雷米熹', targetWeight: 58, currentWeight: 60, bmr: 1302, targetCalories: 1450, targetP: 105, targetC: 150, targetF: 45, goal: '減重體態雕塑' },
    { id: 'u_2', name: '小明', targetWeight: 70, currentWeight: 75, bmr: 1680, targetCalories: 2100, targetP: 140, targetC: 220, targetF: 60, goal: '增肌減脂' },
    { id: 'u_3', name: '莉莉', targetWeight: 50, currentWeight: 52, bmr: 1220, targetCalories: 1350, targetP: 90, targetC: 140, targetF: 40, goal: '健康維持' }
];

// 此網站的紀錄設計為所有訪客皆可瀏覽與新增，因此使用 Supabase 可公開的金鑰。
// 不使用或儲存 service role 私密金鑰，避免把高權限憑證交給網站部署環境。
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mwbyhmhkqwrkhfoyqtmo.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_aQauBQxp_Ts1PIuGoqfPQw_d1ApPlmX';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MEAL_PHOTO_BUCKET = 'meal-photos';
const adminSessions = new Map();

function requireSupabaseConfig() {
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
        throw new Error('共享資料庫連線尚未設定完成。');
    }
}

async function supabaseRequest(endpoint, options = {}) {
    requireSupabaseConfig();
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
        ...options,
        headers: {
            apikey: SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`資料庫操作失敗：${body || response.statusText}`);
    return body ? JSON.parse(body) : null;
}

async function uploadPublicMealPhoto(base64Input, mimeType, profileId, recordDate) {
    if (!base64Input) return null;
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!allowedTypes.has(mimeType)) throw new Error('照片格式僅支援 JPG、PNG 或 WebP。');

    const cleanBase64 = String(base64Input).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    const imageBuffer = Buffer.from(cleanBase64, 'base64');
    if (!imageBuffer.length || imageBuffer.length > 6 * 1024 * 1024) {
        throw new Error('照片大小請小於 6MB。');
    }

    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const safeProfileId = String(profileId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const objectPath = `${safeProfileId}/${recordDate}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${MEAL_PHOTO_BUCKET}/${objectPath}`, {
        method: 'POST',
        headers: {
            apikey: SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
            'Content-Type': mimeType,
            'x-upsert': 'false'
        },
        body: imageBuffer
    });
    if (!response.ok) throw new Error(`照片雲端備份失敗：${await response.text() || response.statusText}`);
    return `${SUPABASE_URL}/storage/v1/object/public/${MEAL_PHOTO_BUCKET}/${objectPath}`;
}

const publicWriteWindow = new Map();
function limitPublicWrites(req, res, next) {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const history = (publicWriteWindow.get(key) || []).filter(timestamp => now - timestamp < 15 * 60 * 1000);
    if (history.length >= 60) {
        return res.status(429).json({ success: false, error: '請稍後再試，避免短時間送出過多資料。' });
    }
    history.push(now);
    publicWriteWindow.set(key, history);
    next();
}

function secureCompare(left, right) {
    const leftBuffer = Buffer.from(left || '');
    const rightBuffer = Buffer.from(right || '');
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireAdmin(req, res, next) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const expiresAt = adminSessions.get(token);
    if (!expiresAt || expiresAt < Date.now()) {
        adminSessions.delete(token);
        return res.status(401).json({ success: false, error: '管理員登入已失效，請重新登入。' });
    }
    next();
}

function profileToDb(profile) {
    return {
        id: String(profile.id), name: String(profile.name).trim(),
        target_weight: Number(profile.targetWeight), current_weight: Number(profile.currentWeight),
        bmr: Number(profile.bmr), target_calories: Number(profile.targetCalories),
        target_protein: Number(profile.targetP), target_carbs: Number(profile.targetC),
        target_fat: Number(profile.targetF), goal: String(profile.goal).trim()
    };
}

function profileToClient(profile) {
    return {
        id: profile.id, name: profile.name, targetWeight: Number(profile.target_weight),
        currentWeight: Number(profile.current_weight), bmr: Number(profile.bmr),
        targetCalories: Number(profile.target_calories), targetP: Number(profile.target_protein),
        targetC: Number(profile.target_carbs), targetF: Number(profile.target_fat), goal: profile.goal
    };
}

function mealToClient(meal) {
    return {
        id: meal.id, profileId: meal.profile_id, recordDate: meal.record_date, type: meal.meal_type,
        name: meal.name, calories: Number(meal.calories), protein: Number(meal.protein),
        carbs: Number(meal.carbs), fat: Number(meal.fat), tip: meal.tip || '', analysis: meal.analysis || '',
        source: meal.source, photoUrl: meal.photo_url || '', createdAt: meal.created_at
    };
}

function waterToClient(record) {
    return {
        id: record.id, profileId: record.profile_id, recordDate: record.record_date,
        volumeMl: Number(record.volume_ml), createdAt: record.created_at
    };
}

async function getSharedRecords() {
    const profiles = await supabaseRequest('nutrition_profiles?select=*&order=created_at.asc');
    const [meals, water] = await Promise.all([
        supabaseRequest('nutrition_meals?select=*&order=record_date.desc,created_at.desc'),
        supabaseRequest('nutrition_water_logs?select=*&order=record_date.desc,created_at.desc')
    ]);
    return {
        profiles: profiles.map(profileToClient), meals: meals.map(mealToClient),
        water: water.map(waterToClient)
    };
}

app.get('/api/shared-records', async (req, res) => {
    try {
        res.json({ success: true, data: await getSharedRecords() });
    } catch (error) {
        console.error('Shared records load error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/shared-profiles', limitPublicWrites, async (req, res) => {
    try {
        const profile = profileToDb(req.body);
        if (!profile.id || !profile.name || Object.values(profile).some(value => value === '' || value === null || Number.isNaN(value))) {
            return res.status(400).json({ success: false, error: '使用者資料不完整。' });
        }
        const created = await supabaseRequest('nutrition_profiles?on_conflict=id', {
            method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(profile)
        });
        const stored = created[0] || (await supabaseRequest(`nutrition_profiles?id=eq.${encodeURIComponent(profile.id)}&limit=1`))[0];
        res.status(201).json({ success: true, data: profileToClient(stored) });
    } catch (error) {
        console.error('Shared profile create error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/shared-meals', limitPublicWrites, async (req, res) => {
    try {
        const input = req.body;
        const meal = {
            profile_id: String(input.profileId || ''), record_date: String(input.recordDate || ''),
            meal_type: String(input.type || '').trim(), name: String(input.name || '').trim(),
            calories: Math.round(Number(input.calories)), protein: Number(input.protein) || 0,
            carbs: Number(input.carbs) || 0, fat: Number(input.fat) || 0,
            tip: String(input.tip || '').trim().slice(0, 1000),
            analysis: String(input.analysis || '').trim().slice(0, 2000),
            source: ['photo', 'text', 'manual'].includes(input.source) ? input.source : 'manual',
            sync_key: String(input.syncKey || '').trim().slice(0, 120)
        };
        if (!meal.profile_id || !/^\d{4}-\d{2}-\d{2}$/.test(meal.record_date) || !meal.meal_type || !meal.name || !Number.isFinite(meal.calories) || meal.calories < 0) {
            return res.status(400).json({ success: false, error: '餐點資料格式不正確。' });
        }
        if (!meal.sync_key) return res.status(400).json({ success: false, error: 'Missing sync key.' });
        if (input.photoBase64) {
            meal.photo_url = await uploadPublicMealPhoto(input.photoBase64, String(input.photoMimeType || 'image/jpeg'), meal.profile_id, meal.record_date);
        }
        const created = await supabaseRequest('nutrition_meals?on_conflict=sync_key', {
            method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(meal)
        });
        const stored = created[0] || (await supabaseRequest(`nutrition_meals?sync_key=eq.${encodeURIComponent(meal.sync_key)}&limit=1`))[0];
        res.status(201).json({ success: true, data: mealToClient(stored) });
    } catch (error) {
        console.error('Shared meal create error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/shared-water', limitPublicWrites, async (req, res) => {
    try {
        const input = req.body || {};
        const water = {
            profile_id: String(input.profileId || ''), record_date: String(input.recordDate || ''),
            volume_ml: Math.round(Number(input.volumeMl)), sync_key: String(input.syncKey || '').trim().slice(0, 120)
        };
        if (!water.profile_id || !/^\d{4}-\d{2}-\d{2}$/.test(water.record_date) || !Number.isInteger(water.volume_ml) || water.volume_ml < 1 || water.volume_ml > 5000) {
            return res.status(400).json({ success: false, error: '喝水紀錄格式不正確，每次請輸入 1–5,000 ml。' });
        }
        if (!water.sync_key) return res.status(400).json({ success: false, error: 'Missing sync key.' });
        const created = await supabaseRequest('nutrition_water_logs?on_conflict=sync_key', {
            method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(water)
        });
        const stored = created[0] || (await supabaseRequest(`nutrition_water_logs?sync_key=eq.${encodeURIComponent(water.sync_key)}&limit=1`))[0];
        res.status(201).json({ success: true, data: waterToClient(stored) });
    } catch (error) {
        console.error('Shared water create error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.patch('/api/shared-water/:id', limitPublicWrites, async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const input = req.body || {};
        const volumeMl = Math.round(Number(input.volumeMl));
        const profileId = String(input.profileId || '');
        const recordDate = String(input.recordDate || '');
        if (!/^[0-9a-f-]{36}$/i.test(id) || !profileId || !/^\d{4}-\d{2}-\d{2}$/.test(recordDate) || !Number.isInteger(volumeMl) || volumeMl < 1 || volumeMl > 5000) {
            return res.status(400).json({ success: false, error: '喝水紀錄格式不正確。' });
        }
        const updated = await supabaseRequest(`nutrition_water_logs?id=eq.${encodeURIComponent(id)}&profile_id=eq.${encodeURIComponent(profileId)}&record_date=eq.${encodeURIComponent(recordDate)}`, {
            method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ volume_ml: volumeMl })
        });
        if (!updated?.[0]) return res.status(404).json({ success: false, error: '找不到可修改的喝水紀錄。' });
        res.json({ success: true, data: waterToClient(updated[0]) });
    } catch (error) {
        console.error('Shared water update error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/shared-water/:id', limitPublicWrites, async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const profileId = String(req.query.profileId || '');
        const recordDate = String(req.query.recordDate || '');
        if (!/^[0-9a-f-]{36}$/i.test(id) || !profileId || !/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) {
            return res.status(400).json({ success: false, error: '喝水紀錄識別資料不正確。' });
        }
        const deleted = await supabaseRequest(`nutrition_water_logs?id=eq.${encodeURIComponent(id)}&profile_id=eq.${encodeURIComponent(profileId)}&record_date=eq.${encodeURIComponent(recordDate)}`, {
            method: 'DELETE', headers: { Prefer: 'return=representation' }
        });
        if (!deleted?.[0]) return res.status(404).json({ success: false, error: '找不到可刪除的喝水紀錄。' });
        res.json({ success: true, data: waterToClient(deleted[0]) });
    } catch (error) {
        console.error('Shared water delete error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/login', limitPublicWrites, (req, res) => {
    if (!ADMIN_PASSWORD) return res.status(503).json({ success: false, error: '管理員登入尚未完成設定。' });
    if (!secureCompare(String(req.body?.password || ''), ADMIN_PASSWORD)) {
        return res.status(401).json({ success: false, error: '管理員密碼不正確。' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    adminSessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
    res.json({ success: true, data: { token, expiresInHours: 12 } });
});

app.delete('/api/admin/all-records', requireAdmin, async (req, res) => {
    try {
        const result = await supabaseRequest('rpc/admin_delete_all_public_records', {
            method: 'POST', body: JSON.stringify({ p_admin_password: ADMIN_PASSWORD })
        });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Admin delete all error:', error);
        res.status(500).json({ success: false, error: '清空資料失敗，備份沒有被刪除。' });
    }
});

app.get('/api/admin/backup-events', requireAdmin, async (req, res) => {
    try {
        const data = await supabaseRequest('rpc/admin_export_backup_events', {
            method: 'POST', body: JSON.stringify({ p_admin_password: ADMIN_PASSWORD })
        });
        res.json({ success: true, data });
    } catch (error) {
        console.error('Admin backup export error:', error);
        res.status(500).json({ success: false, error: '無法下載備份。' });
    }
});

app.post('/api/import-legacy-records', limitPublicWrites, async (req, res) => {
    try {
        const payload = req.body || {};
        if (payload.format !== 'nutrition-consultant-legacy-v1' || !Array.isArray(payload.profiles) || !Array.isArray(payload.meals)) {
            return res.status(400).json({ success: false, error: '匯入檔格式不正確。' });
        }
        if (payload.profiles.length > 60 || payload.meals.length > 2000) {
            return res.status(400).json({ success: false, error: '單次最多可匯入 60 位使用者與 2,000 筆餐點。' });
        }

        const profiles = payload.profiles.map(profileToDb).filter(profile =>
            profile.id && profile.name && !Object.values(profile).some(value => value === '' || value === null || Number.isNaN(value))
        );
        if (!profiles.length) return res.status(400).json({ success: false, error: '匯入檔中沒有有效的使用者資料。' });

        await supabaseRequest('nutrition_profiles?on_conflict=id', {
            method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(profiles)
        });

        const meals = payload.meals.map((input, index) => ({
            profile_id: String(input.profileId || ''), record_date: String(input.recordDate || ''),
            meal_type: String(input.type || '').trim().slice(0, 30), name: String(input.name || '').trim().slice(0, 200),
            calories: Math.round(Number(input.calories)), protein: Number(input.protein) || 0,
            carbs: Number(input.carbs) || 0, fat: Number(input.fat) || 0,
            tip: String(input.tip || '').trim().slice(0, 1000), analysis: String(input.analysis || '').trim().slice(0, 2000),
            source: ['photo', 'text', 'manual'].includes(input.source) ? input.source : 'manual',
            legacy_key: `legacy:${String(input.profileId || '')}:${String(input.recordDate || '')}:${index}:${String(input.name || '').slice(0, 80)}`
        })).filter(meal => meal.profile_id && /^\d{4}-\d{2}-\d{2}$/.test(meal.record_date) && meal.meal_type && meal.name && Number.isFinite(meal.calories) && meal.calories >= 0);

        if (meals.length) {
            await supabaseRequest('nutrition_meals?on_conflict=legacy_key', {
                method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(meals)
            });
        }
        res.json({ success: true, data: { profiles: profiles.length, meals: meals.length } });
    } catch (error) {
        console.error('Legacy records import error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 通用 AI 呼叫處理函式 (支援文字與圖片多模態)
async function callGemini(apiKey, promptParts, responseJsonFormat = false) {
    const activeKey = apiKey || process.env.GEMINI_API_KEY;
    if (!activeKey || activeKey === 'YOUR_GEMINI_API_KEY_HERE') {
        throw new Error('🔑 API Key 尚未設定！請在網頁中填入您的 Gemini API Key 或設定 .env。');
    }

    const ai = new GoogleGenerativeAI(activeKey);
    const candidateModels = [
        'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash',
        'gemini-2.0-flash', 'gemini-1.5-flash-latest', 'gemini-1.5-flash'
    ];

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
                m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')
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

function validatePhotoPayload(imageBase64, mimeType) {
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!allowedTypes.has(mimeType)) throw new Error('照片格式僅支援 JPG、PNG 或 WebP。');
    const cleanBase64 = String(imageBase64 || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    if (!cleanBase64 || !/^[A-Za-z0-9+/=\s]+$/.test(cleanBase64)) throw new Error('照片資料格式不正確。');
    const imageBuffer = Buffer.from(cleanBase64, 'base64');
    if (!imageBuffer.length || imageBuffer.length > 6 * 1024 * 1024) throw new Error('照片大小請小於 6MB。');
    return cleanBase64;
}

function parseAiJson(jsonText) {
    const text = String(jsonText || '').trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced ? fenced[1] : text).trim();
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('AI 回覆格式不完整，請再試一次。');
    try {
        return JSON.parse(candidate.slice(start, end + 1));
    } catch {
        throw new Error('AI 回覆格式暫時無法解析，請再試一次。');
    }
}

function normalizeMealAnalysis(data) {
    const numeric = key => {
        const value = Number(data?.[key]);
        return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
    };
    const mealName = String(data?.mealName || '').trim().slice(0, 200);
    if (!mealName) throw new Error('AI 未辨識出可儲存的餐點名稱，請換一張較清楚的照片。');
    return {
        mealName,
        calories: numeric('calories'), protein: numeric('protein'), carbs: numeric('carbs'), fat: numeric('fat'),
        tip: String(data?.tip || '').trim().slice(0, 1000),
        analysis: String(data?.analysis || '').trim().slice(0, 2000)
    };
}

// ---------------------------------------------------------
// 1. 智遊秘書 AI 助理：旅遊行程生成 API
// ---------------------------------------------------------
app.post('/api/generate-plan', limitPublicWrites, async (req, res) => {
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
app.post('/api/parse-meal', limitPublicWrites, async (req, res) => {
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
        const data = normalizeMealAnalysis(parseAiJson(jsonText));

        return res.json({ success: true, data });
    } catch (error) {
        console.error('Parse Meal Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ---------------------------------------------------------
// 3. ✨【全新功能】AI 專屬營養師：食物照片 Vision 辨識分析 API
// ---------------------------------------------------------
app.post('/api/parse-food-image', limitPublicWrites, async (req, res) => {
    try {
        const { imageBase64, mimeType = 'image/jpeg', mealType = '午餐', photoDescription = '', apiKey } = req.body;

        if (!imageBase64) {
            return res.status(400).json({ success: false, error: '請上傳或拍攝一張食物照片！' });
        }

        const cleanBase64 = validatePhotoPayload(imageBase64, mimeType);

        const userDescription = String(photoDescription || '').trim().slice(0, 500);
        const prompt = `
你是一位具備視覺影像辨識能力的頂尖專業營養師與美食熱量專家。
請仔細觀察這張照片中的食物：
1. 識別出照片中的主要菜餚、食材與份量。
2. 估算出此餐點的總熱量(kcal)與三大營養素：蛋白質(g)、碳水化合物(g)、脂肪(g)。
3. 用繁體中文說明辨識依據、可能的份量與熱量估算限制。
4. 給予一句親切且具體的營養建議。照片辨識與份量估算可能有誤差，不可當作醫療或治療建議。

使用者對此餐點的補充說明：${userDescription || '未提供'}
請將補充說明視為估算參考；若與照片不一致，以照片可見內容為主，並在 analysis 中誠實說明不確定處。

請【只輸出以下 JSON 格式】（不要包含任何額外說明文字）：
{
  "mealName": "識別出的食物名稱 (例如：煎鮭魚沙拉配水煮蛋、排骨便當)",
  "calories": 熱量估算值(整數kcal),
  "protein": 蛋白質估估值(整數g),
  "carbs": 碳水化合物估算值(整數g),
  "fat": 脂肪估算值(整數g),
  "tip": "針對照片食物的一句話專業點評",
  "analysis": "2 到 4 句繁體中文說明：辨識到的食物與估計份量、熱量／營養素主要來源、估算的不確定性；不可給醫療診斷。"
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
        const data = normalizeMealAnalysis(parseAiJson(jsonText));

        return res.json({ success: true, data });

    } catch (error) {
        console.error('Parse Food Image Error:', error);
        return res.status(500).json({ success: false, error: error.message || '照片分析失敗，請重試或更換照片。' });
    }
});

// ---------------------------------------------------------
// 4. AI 專屬營養師：菜單推薦 API
// ---------------------------------------------------------
app.post('/api/recommend-meal', limitPublicWrites, async (req, res) => {
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

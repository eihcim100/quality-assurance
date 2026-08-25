const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "MichieAdmin2024";

const API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6JVw0CaSMkYQ1441zAMJ8_8HbIr3SCUMZ1vb4MvNtfnUQ"; 
const genAI = new GoogleGenerativeAI(API_KEY);

// Set up public folder and persistent uploads directory
const publicDir = path.join(__dirname, 'public');
const uploadDir = path.join(publicDir, 'uploads');
const dataFilePath = path.join(uploadDir, 'qa-reports.json');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Load database into memory
let reports = [];
function loadReports() {
    if (fs.existsSync(dataFilePath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(dataFilePath));
            reports = Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            reports = [];
        }
    }
}
loadReports();

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, uploadDir); },
    filename: (req, file, cb) => { cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.]/g, '')); }
});

const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } }); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

async function runQAAnalysis(filePaths, details) {
    const model = genAI.getGenerativeModel({ model: "gemini-3.1-pro-preview" }); 
    
    const imageParts = filePaths.map((p) => ({ 
        inlineData: { 
            data: Buffer.from(fs.readFileSync(p)).toString('base64'), 
            mimeType: "image/jpeg" 
        } 
    }));

    const prompt = `ACT AS: Master QA Inspector for Michie Auto Detailing LLC. 
    You are evaluating an Independent Contractor's post-detail photos to ensure they meet the strict standards outlined in the Independent Contractor Agreement.

    CONTEXT:
    - Contractor: ${details.contractorName}
    - Vehicle: ${details.vehicleYear} ${details.vehicleMake} ${details.vehicleModel} (${details.vehicleType})
    - Completed Level: ${details.serviceLevel}
    - Biohazard Remediation Performed: ${details.biohazard}
    - Smoke/Odor Remediation Performed: ${details.smoke}
    - Photo Sequence: ${details.labels.join(', ')}

    CONTRACTOR AGREEMENT RULES:
    1. Premium Quality: The contractor must use high-quality chemicals. Surfaces should look treated, not greasy or dry.
    2. "When in doubt, clean it out": No obvious dirt, streaks, mud, or un-vacuumed pet hair should remain.
    3. Biohazard: If Biohazard is true, there must be NO TRACE of stains/bodily fluids.
    4. Level 3 requires meticulous, flawless cleaning (cupholders, cracks, crevices). Level 1 is a basic but thorough refresh.

    TASK:
    1. Analyze all provided images in sequence. Look closely for streaks on glass, dirt in door jambs, unvacuumed carpets, dirty wheels, etc.
    2. Provide an honest, strict QA score from 0.0 to 10.0 (Use decimals, e.g., 8.4, 9.2). 
       - 9.5-10.0: Perfect, flawless execution.
       - 8.0-9.4: Great job, minor easily fixable issues.
       - 6.0-7.9: Acceptable, but noticeable corners cut.
       - < 6.0: Poor, failed inspection.
    3. Provide an executive summary of the work. Address the contractor directly and professionally.
    4. Provide specific feedback for EACH photo label provided in the sequence. Point out what they did well in that specific shot, or what they missed.

    RETURN ONLY STRICT JSON FORMAT:
    {
        "score": 8.7,
        "summary": "Great work on the interior extraction, but the wheels could use a bit more tire shine...",
        "analysis": [
            {"label": "Front Exterior", "feedback": "Paint looks glossy and streak-free."}
        ]
    }`;

    try {
        const result = await model.generateContent([prompt, ...imageParts]);
        const response = await result.response;
        let text = response.text().replace(/```json/g, "").replace(/```/g, "").trim();
        return JSON.parse(text);
    } catch (error) {
        console.error("Gemini Parsing Error:", error);
        throw new Error("AI Analysis Failed.");
    }
}

// --- PORTAL ENDPOINTS ---

app.post('/api/qa-scan', upload.array('photos', 30), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No photos uploaded." });
        }

        const filePaths = req.files.map(f => f.path);
        
        const details = {
            contractorName: req.body.contractorName,
            vehicleYear: req.body.vehicleYear,
            vehicleMake: req.body.vehicleMake,
            vehicleModel: req.body.vehicleModel,
            vehicleType: req.body.vehicleType,
            serviceLevel: req.body.serviceLevel,
            biohazard: req.body.biohazard,
            smoke: req.body.smoke,
            labels: JSON.parse(req.body.labels || "[]")
        };

        const aiReport = await runQAAnalysis(filePaths, details);

        // Inject image URLs into the analysis breakdown for the admin portal
        const formattedAnalysis = details.labels.map((label, index) => {
            let feedback = "No specific feedback provided by AI.";
            if (aiReport.analysis && aiReport.analysis[index]) {
                feedback = aiReport.analysis[index].feedback;
            } else if (aiReport.analysis) {
                const match = aiReport.analysis.find(a => a.label === label);
                if (match) feedback = match.feedback;
            }

            return {
                label: label,
                feedback: feedback,
                img: '/uploads/' + path.basename(filePaths[index] || '')
            };
        });

        // Construct Database Record
        const reportData = {
            id: Date.now().toString(),
            timestamp: new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }),
            contractor: details.contractorName,
            vehicle: `${details.vehicleYear} ${details.vehicleMake} ${details.vehicleModel}`,
            serviceLevel: details.serviceLevel,
            score: aiReport.score,
            summary: aiReport.summary,
            analysis: formattedAnalysis
        };

        // Save to Database
        reports.unshift(reportData);
        fs.writeFileSync(dataFilePath, JSON.stringify(reports));

        // Return the clean data to the contractor frontend
        res.json({
            score: aiReport.score,
            summary: aiReport.summary,
            analysis: formattedAnalysis
        });

    } catch (e) {
        console.error("QA Scan Error:", e);
        res.status(500).json({ error: true, message: e.message });
    }
});

// --- ADMIN ENDPOINTS ---

app.post('/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) res.sendStatus(200);
    else res.sendStatus(401);
});

app.get('/admin/reports', (req, res) => {
    res.json(reports);
});

app.delete('/admin/reports/:id', (req, res) => {
    const id = req.params.id;
    const report = reports.find(r => r.id === id);
    
    // Delete the saved images from the hard drive
    if (report && report.analysis) {
        report.analysis.forEach(item => {
            if (item.img) {
                const filePath = path.join(publicDir, item.img);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        });
    }
    
    reports = reports.filter(r => r.id !== id);
    fs.writeFileSync(dataFilePath, JSON.stringify(reports));
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Contractor QA API running on port ${PORT}`);
});

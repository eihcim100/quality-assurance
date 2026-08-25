const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

// Set up Gemini. Add your actual key on Render via Environment Variables.
const API_KEY = process.env.GEMINI_API_KEY || "YOUR_GEMINI_API_KEY_HERE"; 
const genAI = new GoogleGenerativeAI(API_KEY);

// Multer storage setup (stores temporarily in memory for speed before processing, or disk)
// Given 24 images, disk storage is safer for memory limits on standard Render instances.
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, uploadDir); },
    filename: (req, file, cb) => { cb(null, Date.now() + '-' + file.originalname); }
});

// Allow up to 30 photos to be safe
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } }); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Assuming you put contractor-portal.html in a /public folder

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

async function runQAAnalysis(filePaths, details) {
    const model = genAI.getGenerativeModel({ model: "gemini-3.1-pro-preview" }); 
    
    // Convert files to base64 inline data format for Gemini
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
            {"label": "Front Exterior", "feedback": "Paint looks glossy and streak-free."},
            {"label": "Hood", "feedback": "Good gloss, no visible bug guts."}
            // ... must include exactly all labels passed in the prompt
        ]
    }`;

    try {
        const result = await model.generateContent([prompt, ...imageParts]);
        const response = await result.response;
        // Clean markdown if present
        let text = response.text().replace(/```json/g, "").replace(/```/g, "").trim();
        return JSON.parse(text);
    } catch (error) {
        console.error("Gemini Parsing Error:", error);
        throw new Error("AI Analysis Failed.");
    }
}

app.post('/api/qa-scan', upload.array('photos', 30), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No photos uploaded." });
        }

        const filePaths = req.files.map(f => f.path);
        
        // Extract data
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

        // Run Gemini QA
        const aiReport = await runQAAnalysis(filePaths, details);

        // Cleanup temporary files after analysis to save server space
        filePaths.forEach(fp => {
            if(fs.existsSync(fp)) fs.unlinkSync(fp);
        });

        // Optional: Save this report to a database here so admin can view it later

        res.json(aiReport);

    } catch (e) {
        console.error("QA Scan Error:", e);
        res.status(500).json({ error: true, message: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Contractor QA API running on port ${PORT}`);
});

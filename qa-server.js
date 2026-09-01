const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "MichieAdmin2024";

// Inter-service Communication Keys
const CRM_API_URL = process.env.CRM_API_URL || "https://michie-detailing-backend.onrender.com";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "YOUR_ADMIN_API_KEY"; 

const API_KEY = process.env.GEMINI_API_KEY || "GEMINI_API_KEY"; 
const genAI = new GoogleGenerativeAI(API_KEY);

// Deel API Configuration
const DEEL_API_KEY = process.env.DEEL_API_KEY; 
const DEEL_API_URL = "https://api.letsdeel.com/rest"; 

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

// Setting max limit to 30 files for the Full Detail scope
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } }); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// --- FIXED DOMAIN ROUTING FOR BEFORE PHOTOS ---
async function fetchImageToB64(url) {
    try {
        // Explicitly route to quote.michieauto.com where the images are hosted
        if (!url.startsWith('http://') && !url.startsWith('https://')) { 
            url = 'https://quote.michieauto.com' + (url.startsWith('/') ? '' : '/') + url; 
        }
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer).toString('base64');
    } catch (e) {
        console.error("Failed to fetch before photo from quote server:", url, e);
        return null;
    }
}

// Helper function to trigger instant QA bonus via Deel
async function issueDeelBonus(contractId, amount, description) {
    if (!DEEL_API_KEY) {
        console.error("Deel API key is missing. Skipping bonus payout.");
        return;
    }

    try {
        const response = await fetch(`${DEEL_API_URL}/invoice-adjustments`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${DEEL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                data: {
                    type: "bonus",
                    amount: amount,
                    contract_id: contractId,
                    description: description
                }
            })
        });
        
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Deel API error: ${response.status} - ${err}`);
        }
        console.log(`Successfully issued $${amount} bonus to contract ${contractId}`);
    } catch (e) {
        console.error("Failed to trigger Deel payment:", e);
    }
}

async function runQAAnalysis(filePaths, details, beforePhotosUrls = []) {
    const model = genAI.getGenerativeModel({ model: "gemini-3.1-pro-preview" }); // KEEP THIS LINE THE SAME DO NOT CHANGE
    
    let promptParts = [];
    
    const promptText = `ACT AS: Master QA Inspector for Michie Auto Detailing LLC. 
    You are evaluating an Independent Contractor's post-detail photos to ensure they meet the strict standards outlined in the Independent Contractor Agreement.

    CONTEXT:
    - Contractor: ${details.contractorName}
    - Vehicle: ${details.vehicleYear} ${details.vehicleMake} ${details.vehicleModel} (${details.vehicleType})
    - Scope of Work: ${details.detailType}
    - Completed Level: ${details.serviceLevel}
    - Biohazard Remediation Performed: ${details.biohazard}
    - Smoke/Odor Remediation Performed: ${details.smoke}

    CONTRACTOR AGREEMENT RULES:
    1. Scope Consideration: Judge ONLY the areas included in the scope of work (${details.detailType}).
    2. Premium Quality: The contractor must use high-quality chemicals. Surfaces should look treated, not greasy or dry.
    3. "When in doubt, clean it out": No obvious dirt, streaks, mud, or un-vacuumed pet hair should remain.
    4. Biohazard: If Biohazard is true, there must be NO TRACE of stains/bodily fluids.
    5. Level 3 requires meticulous cleaning. Level 1 is a basic refresh.
    6. IMAGE VERIFICATION: If the submitted photo clearly does not match its requested label (e.g., an exterior photo was submitted for an interior seat label), you MUST fail it immediately and explicitly state that the wrong photo was provided.

    TASK:
    1. Analyze the provided sequence of After Photos. Each photo will have its label attached to it.
    2. If "BEFORE" photos are provided, use them to gauge the transformation.
    3. Provide an honest, strict QA score from 0.0 to 10.0 based on the results.
    4. Provide an executive summary of the work.
    5. Provide specific feedback for EVERY SINGLE AFTER photo label provided. You MUST return exactly ${details.labels.length} items in your analysis array.

    RETURN ONLY STRICT JSON FORMAT EXACTLY LIKE THIS:
    {
        "score": 8.7,
        "summary": "Great work on the interior extraction, but...",
        "analysis": [
            {"label": "Label 1 goes here", "feedback": "Feedback for photo 1..."},
            {"label": "Label 2 goes here", "feedback": "Feedback for photo 2..."}
        ]
    }`;

    promptParts.push(promptText);

    // Group BEFORE photos
    if (beforePhotosUrls && beforePhotosUrls.length > 0) {
        promptParts.push("\n--- BEFORE PHOTOS (TAKEN BY CLIENT PRE-DETAIL) ---\n");
        for (let url of beforePhotosUrls) {
            const b64 = await fetchImageToB64(url);
            if (b64) promptParts.push({ inlineData: { data: b64, mimeType: "image/jpeg" } });
        }
    }

    promptParts.push("\n--- AFTER PHOTOS (TAKEN BY CONTRACTOR POST-DETAIL) ---\n");
    
    // NEW FIX: Interleave the text label directly BEFORE the corresponding image payload
    // This physically prevents the AI from losing track of which image is which.
    filePaths.forEach((p, index) => {
        const currentLabel = details.labels[index] || `Photo ${index + 1}`;
        promptParts.push(`\nEvaluating: ${currentLabel}`);
        promptParts.push({ 
            inlineData: { data: Buffer.from(fs.readFileSync(p)).toString('base64'), mimeType: "image/jpeg" } 
        });
    });

    try {
        const result = await model.generateContent(promptParts);
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
            jobId: req.body.jobId, // Pulled from the hidden form field via URL params
            contractorName: req.body.contractorName,
            vehicleYear: req.body.vehicleYear,
            vehicleMake: req.body.vehicleMake,
            vehicleModel: req.body.vehicleModel,
            vehicleType: req.body.vehicleType,
            detailType: req.body.detailType,
            serviceLevel: req.body.serviceLevel,
            biohazard: req.body.biohazard,
            smoke: req.body.smoke,
            labels: JSON.parse(req.body.labels || "[]")
        };

        // CENTRALIZED BRAIN: Retrieve the AI Before Photos & Pricing securely from the main Job Database
        let beforePhotosUrls = [];
        let leadClientName = "N/A";
        let leadPrice = "N/A";
        let leadPay = "N/A";
        let leadAiNotes = "N/A";

        if (details.jobId) {
            try {
                const leadRes = await fetch(`${CRM_API_URL}/api/internal/lead/${details.jobId}`, {
                    headers: { 'X-Admin-API-Key': ADMIN_API_KEY }
                });
                if (leadRes.ok) {
                    const leadData = await leadRes.json();
                    if (leadData.before_photos) {
                        beforePhotosUrls = typeof leadData.before_photos === 'string' 
                            ? JSON.parse(leadData.before_photos) 
                            : leadData.before_photos;
                    }
                    // NEW: Capture the pricing and client data
                    leadClientName = leadData.customer_name || "N/A";
                    leadPrice = leadData.service_cost || "N/A";
                    leadPay = leadData.contractor_expense || "N/A";
                    leadAiNotes = leadData.ai_notes || "N/A";
                }
            } catch (e) {
                console.error("Could not fetch CRM lead data for QA:", e);
            }
        }

        const aiReport = await runQAAnalysis(filePaths, details, beforePhotosUrls);

        // --- DEEL AUTOMATED PAYOUT LOGIC ---
        // Check if a report for this specific job already exists and was paid
        const existingReport = reports.find(r => r.jobId === details.jobId);
        let bonusPaidOut = false;

        if (existingReport && existingReport.bonusPaid) {
            console.log(`Bonus already paid for Job ${details.jobId}. Skipping Deel API call.`);
            bonusPaidOut = true;
        } else if (aiReport.score >= 9.0) {
            // Note: Make sure 'deelContractId' is successfully passed from your frontend or CRM fetch
            const deelContractId = req.body.deelContractId; 
            const bonusAmount = 50; 
            
            if (deelContractId) {
                // Do not 'await' so the frontend receives the AI report immediately
                issueDeelBonus(
                    deelContractId, 
                    bonusAmount, 
                    `QA Inspection Passed - Job: ${details.jobId} - Score: ${aiReport.score}`
                );
                bonusPaidOut = true;
            } else {
                console.warn(`Contractor scored ${aiReport.score}, but no Deel Contract ID was found.`);
            }
        }
        // -------------------------------------

        // Inject image URLs into the analysis breakdown for the admin portal
        const formattedAnalysis = details.labels.map((label, index) => {
            let feedback = "No specific feedback provided by AI.";
            
            if (aiReport.analysis && Array.isArray(aiReport.analysis)) {
                // Find the exact label, making it case-insensitive just to be safe
                const match = aiReport.analysis.find(a => 
                    a.label && a.label.toLowerCase() === label.toLowerCase()
                );
                
                if (match && match.feedback) {
                    feedback = match.feedback;
                }
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
            jobId: details.jobId, // Ensure jobId is saved for the idempotency check
            timestamp: new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }),
            contractor: details.contractorName,
            vehicle: `${details.vehicleYear} ${details.vehicleMake} ${details.vehicleModel}`,
            detailType: details.detailType,
            serviceLevel: details.serviceLevel,
            score: aiReport.score,
            summary: aiReport.summary,
            analysis: formattedAnalysis,
            
            // NEW: Save the fetched CRM data into the QA database
            clientName: leadClientName,
            price: leadPrice,
            contractorPay: leadPay,
            aiNotes: leadAiNotes,
            beforePhotos: beforePhotosUrls,
            bonusPaid: bonusPaidOut // Save the payment flag
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

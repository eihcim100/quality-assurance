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
const DEEL_API_KEY = process.env.DEEL_API_KEY || "YOUR_DEEL_API_KEY";

const API_KEY = process.env.GEMINI_API_KEY || "GEMINI_API_KEY"; 
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

// Memory lock to prevent spam-click duplicate payouts
const activeProcessingJobs = new Set();

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

// --- DEEL API HELPER FUNCTION ---
// --- DEEL API HELPER FUNCTION ---
async function issueDeelBonus(contractId, amount, reason) {
    try {
        console.log(`Attempting Deel Payout... Contract: ${contractId}, Amount: $${amount}`);
        
        // CORRECTED: Endpoint for Independent Contractor 'Invoice Adjustments'
        const response = await fetch(`https://api.letsdeel.com/rest/v2/invoice-adjustments`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${DEEL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                data: {
                    contract_id: contractId,
                    amount: amount,
                    description: reason,
                    type: "bonus" // Must be strictly lowercase for the invoice-adjustments endpoint
                }
            })
        });

        // Safely check if Deel returned JSON or an HTML error page so it doesn't crash
        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            const textError = await response.text();
            console.error(`❌ DEEL API ROUTING ERROR (Not JSON):`, textError.substring(0, 150));
            return;
        }

        const data = await response.json();
        
        if (response.ok) {
            console.log(`✅ DEEL SUCCESS: Paid $${amount} for contract ${contractId}`);
        } else {
            console.error(`❌ DEEL API REJECTED PAYMENT:`, JSON.stringify(data, null, 2));
        }
    } catch (error) {
        console.error(`❌ DEEL NETWORK ERROR:`, error.message);
    }
}

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

async function runQAAnalysis(filePaths, details, beforePhotosUrls = []) {
    const model = genAI.getGenerativeModel({ model: "gemini-3.1-pro-preview" }); 
    
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
    - Photo Sequence: ${details.labels.join(', ')}

    CONTRACTOR AGREEMENT RULES:
    1. Scope Consideration: Judge ONLY the areas included in the scope of work (${details.detailType}).
    2. Premium Quality: The contractor must use high-quality chemicals. Surfaces should look treated, not greasy or dry.
    3. "When in doubt, clean it out": No obvious dirt, streaks, mud, or un-vacuumed pet hair should remain.
    4. Biohazard: If Biohazard is true, there must be NO TRACE of stains/bodily fluids.
    5. Level 3 requires meticulous cleaning. Level 1 is a basic refresh.

    TASK:
    1. Analyze the provided photos. If "BEFORE" photos are provided, directly compare the condition of the vehicle before the detail to the "AFTER" photos completed by the contractor.
    2. Provide an honest, strict QA score from 0.0 to 10.0 based on the transformation and final results (Use decimals, e.g., 8.4, 9.2). 
       - 9.5-10.0: Perfect, flawless execution.
       - 8.0-9.4: Great job, minor easily fixable issues.
       - 6.0-7.9: Acceptable, but noticeable corners cut.
       - < 6.0: Poor, failed inspection.
    3. Provide an executive summary of the work. Address the contractor directly and professionally.
    4. Provide specific feedback for EVERY SINGLE AFTER photo label provided in the sequence. You MUST return exactly ${details.labels.length} items in your analysis array.

    RETURN ONLY STRICT JSON FORMAT EXACTLY LIKE THIS:
    {
        "score": 8.7,
        "summary": "Great work on the interior extraction, but...",
        "analysis": [
            {"label": "Label 1 goes here", "feedback": "Feedback for photo 1..."},
            {"label": "Label 2 goes here", "feedback": "Feedback for photo 2..."},
            {"label": "Label 3 goes here", "feedback": "Feedback for photo 3..."}
            // ... You must continue and include an object for ALL labels in the Photo Sequence!
        ]
    }`;

    promptParts.push(promptText);

    // Interleave the Before and After Photos into the Gemini Context Array
    if (beforePhotosUrls && beforePhotosUrls.length > 0) {
        promptParts.push("\n--- BEFORE PHOTOS (TAKEN BY CLIENT PRE-DETAIL) ---\n");
        for (let url of beforePhotosUrls) {
            const b64 = await fetchImageToB64(url);
            if (b64) promptParts.push({ inlineData: { data: b64, mimeType: "image/jpeg" } });
        }
    }

    promptParts.push("\n--- AFTER PHOTOS (TAKEN BY CONTRACTOR POST-DETAIL) ---\n");
    const afterImageParts = filePaths.map((p) => ({ 
        inlineData: { data: Buffer.from(fs.readFileSync(p)).toString('base64'), mimeType: "image/jpeg" } 
    }));
    promptParts.push(...afterImageParts);

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
    const incomingJobId = req.body.jobId;

    // 1. CHECK THE LOCK: Is this job already being scanned right now?
    if (incomingJobId && activeProcessingJobs.has(incomingJobId)) {
        return res.status(429).json({ error: true, message: "A scan is already in progress for this job. Please wait." });
    }

    // 2. LOCK IT: Add this job to the active list so no other requests can get in
    if (incomingJobId) {
        activeProcessingJobs.add(incomingJobId);
    }

    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No photos uploaded." });
        }

        const filePaths = req.files.map(f => f.path);
        
        const details = {
            jobId: incomingJobId, // Uses the captured ID
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
                    leadClientName = leadData.full_name || leadData.customer_name || "N/A";
                    leadPrice = leadData.package_price || leadData.service_cost || "N/A";
                    
                    // FETCH DYNAMIC PAYOUT: Supports both legacy schema and the newer aliased schema
                    leadPay = leadData.contractor_pay || leadData.contractor_expense || "N/A";
                    leadAiNotes = leadData.ai_notes || "N/A";
                    
                    // SECURITY: Hydrate the contract ID directly from your database (LEFT JOINed in app.py)
                    if (leadData.deel_contract_id) {
                        req.body.deelContractId = leadData.deel_contract_id;
                    }
                }
            } catch (e) {
                console.error("Could not fetch CRM lead data for QA:", e);
            }
        }

        const aiReport = await runQAAnalysis(filePaths, details, beforePhotosUrls);

        // --- DEEL AUTOMATED PAYOUT LOGIC ---
        // SECURITY: Scan the entire history to ensure this job hasn't ALREADY been paid out successfully
        const alreadyPaid = reports.some(r => r.jobId === details.jobId && r.bonusPaid === true);
        let bonusPaidOut = false;

        if (alreadyPaid) {
            console.warn(`SECURITY: Payout already issued for Job ${details.jobId}. Blocking duplicate payment attempt.`);
            bonusPaidOut = true; // Preserve the paid state so the frontend knows it was handled previously
        } else if (aiReport.score > 1.0 ) { // <-- THRESHOLD LOWERED TO > 1.0
            // Securely mapped from the CRM fetch above
            const deelContractId = req.body.deelContractId; 
            
            // Extract all distinct numbers (including decimals) from the pay string and sum them up
            // Example: "$120 + $52 BONUS" -> [120, 52] -> 172
            let dynamicPayAmount = 0;
            const payMatches = String(leadPay).match(/\d+(\.\d+)?/g);
            if (payMatches) {
                dynamicPayAmount = payMatches.reduce((sum, val) => sum + parseFloat(val), 0);
            }
            
            if (deelContractId && !isNaN(dynamicPayAmount) && dynamicPayAmount > 0) {
                // HARD CAP SAFETY RULE: Prevent any single payout >= $300
                if (dynamicPayAmount >= 300) {
                    console.error(`SAFETY FLAG: Auto-payout of $${dynamicPayAmount} for Job ${details.jobId} hits the $300 limit. Blocked for manual admin review.`);
                } else {
                    // Do not 'await' so the frontend receives the AI report immediately
                    issueDeelBonus(
                        deelContractId, 
                        dynamicPayAmount, 
                        `Job Completed: ${details.jobId} - QA Score: ${aiReport.score}`
                    );
                    bonusPaidOut = true;
                }
            } else {
                console.warn(`Contractor scored ${aiReport.score}, but missing Deel Contract ID or valid Pay Amount (${leadPay}).`);
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
            jobId: details.jobId,           // <-- REQUIRED: Saves Job ID to prevent duplicate payments
            bonusPaid: bonusPaidOut,        // <-- REQUIRED: Saves Payout Status to prevent duplicate payments
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
            beforePhotos: beforePhotosUrls
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
    } finally {
        // 3. UNLOCK IT: No matter what happens (success or crash), remove the lock when finished
        if (incomingJobId) {
            activeProcessingJobs.delete(incomingJobId);
        }
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

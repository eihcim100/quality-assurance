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

// Retell AI Variables
const RETELL_SERVICE_URL = process.env.RETELL_SERVICE_URL || "https://your-python-service.onrender.com"; // Set this to your python app URL
const RETELL_QA_AGENT_ID = process.env.RETELL_QA_AGENT_ID || "YOUR_QA_AGENT_ID"; // The ID of the agent doing the follow-up

const API_KEY = process.env.GEMINI_API_KEY || "GEMINI_API_KEY"; 
const genAI = new GoogleGenerativeAI(API_KEY);

// Set up public folder and persistent uploads directory
const publicDir = path.join(__dirname, 'public');

// Automatically route to the persistent disk if running on Render
let uploadDir = process.env.RENDER ? '/var/data' : path.join(publicDir, 'uploads');

// Ensure upload directory exists, with fallback for missing Render Disk
try {
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }
} catch (err) {
    if (err.code === 'EACCES') {
        console.warn(`\n⚠️ RENDER DISK MISSING: Permission denied creating '${uploadDir}'.\nTo fix disappearing images:\n1. Go to Render Dashboard > Your Service > Disks\n2. Add a disk with Mount Path: /var/data\nFalling back to temporary local storage...\n`);
        uploadDir = path.join(publicDir, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    } else {
        console.error("Directory creation error:", err);
    }
}

const dataFilePath = path.join(uploadDir, 'qa-reports.json');

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

// Tell Express to serve the images from the persistent disk folder
app.use('/uploads', express.static(uploadDir));

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// --- DEEL API HELPER FUNCTION ---
async function issueDeelBonus(contractId, amount, reason) {
    try {
        console.log(`Attempting Instant Deel Payout... Contract: ${contractId}, Amount: $${amount}`);
        const today = new Date().toISOString().split('T')[0];

        // 1. CREATE AN OFF-CYCLE PAYMENT
        const offCycleRes = await fetch(`https://api.letsdeel.com/rest/v2/contracts/${contractId}/off-cycle-payments`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${DEEL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                data: {
                    amount: amount,
                    description: reason,
                    date_submitted: today,
                    is_auto_approved: true // 👈 Add this flag to bypass manual review
                }
            })
        });

        const offCycleData = await offCycleRes.json();
        
        if (!offCycleRes.ok) {
            console.error(`❌ DEEL OFF-CYCLE FAILED:`, JSON.stringify(offCycleData, null, 2));
            return;
        }

        console.log(`✅ DEEL SUCCESS: Created Off-Cycle Invoice.`);
        const invoiceId = offCycleData.data?.id;

        // 2. IMMEDIATELY FUND THE INVOICE
        if (invoiceId) {
            const idempotencyKey = `fund-${invoiceId}-${Date.now()}`;
            
            const fundRes = await fetch(`https://api.letsdeel.com/rest/payments/statements`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${DEEL_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idempotencyKey
                },
                body: JSON.stringify({
                    data: {
                        payment: {
                            country: "US",
                            currency: "USD"
                        },
                        invoice_ids: [invoiceId]
                    }
                })
            });

            if (fundRes.ok) {
                console.log(`✅ DEEL FUNDING SUCCESS: Funds have been released instantly!`);
            } else {
                console.error(`⚠️ DEEL Funding Failed:`, await fundRes.text());
            }
        }
    } catch (error) {
        console.error(`❌ DEEL NETWORK ERROR:`, error.message);
    }
}

// --- FIXED DOMAIN ROUTING FOR BEFORE PHOTOS ---
async function fetchImageToB64(url) {
    try {
        if (!url.startsWith('http://') && !url.startsWith('https://')) { 
            url = 'https://quote.michieauto.com' + (url.startsWith('/') ? '' : '/') + url; 
        }
        const response = await fetch(url);
        
        // Prevent processing 404 HTML pages as images
        if (!response.ok) {
            console.error(`Failed to fetch image, received status ${response.status} for url: ${url}`);
            return null; 
        }

        const mimeType = response.headers.get('content-type') || "image/jpeg";
        const arrayBuffer = await response.arrayBuffer();
        
        return {
            b64: Buffer.from(arrayBuffer).toString('base64'),
            mimeType: mimeType
        };
    } catch (e) {
        console.error("Failed to fetch before photo from quote server:", url, e);
        return null;
    }
}

async function runQAAnalysis(filesData, details, beforePhotosUrls = []) {
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
        ]
    }`;

    promptParts.push(promptText);

    if (beforePhotosUrls && beforePhotosUrls.length > 0) {
        promptParts.push("\n--- BEFORE PHOTOS (TAKEN BY CLIENT PRE-DETAIL) ---\n");
        for (let url of beforePhotosUrls) {
            const imageData = await fetchImageToB64(url);
            if (imageData) promptParts.push({ inlineData: { data: imageData.b64, mimeType: imageData.mimeType } });
        }
    }

    promptParts.push("\n--- AFTER PHOTOS (TAKEN BY CONTRACTOR POST-DETAIL) ---\n");
    const afterImageParts = filesData.map((f) => ({ 
        inlineData: { data: Buffer.from(fs.readFileSync(f.path)).toString('base64'), mimeType: f.mimeType } 
    }));
    promptParts.push(...afterImageParts);

    try {
        const result = await model.generateContent(promptParts);
        const response = await result.response;
        let text = response.text().replace(/
```json/g, "").replace(/```/g, "").trim();
        return JSON.parse(text);
    } catch (error) {
        console.error("Gemini Parsing Error:", error);
        throw new Error("AI Analysis Failed.");
    }
}

// --- PORTAL ENDPOINTS ---

app.post('/api/qa-scan', upload.array('photos', 30), async (req, res) => {
    const incomingJobId = req.body.jobId;

    if (incomingJobId && activeProcessingJobs.has(incomingJobId)) {
        return res.status(429).json({ error: true, message: "A scan is already in progress for this job. Please wait." });
    }

    if (incomingJobId) {
        activeProcessingJobs.add(incomingJobId);
    }

    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No photos uploaded." });
        }

        const filesData = req.files.map(f => ({ path: f.path, mimeType: f.mimetype }));
        
        const details = {
            jobId: incomingJobId, 
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

        let beforePhotosUrls = [];
        let leadClientName = "N/A";
        let leadClientPhone = "N/A";
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
                    
                    // NEW: Extract photos whether they are an array of strings or an array of nested breakdown objects
                    let rawPhotos = [];
                    if (leadData.before_photos) {
                        rawPhotos = typeof leadData.before_photos === 'string' 
                            ? JSON.parse(leadData.before_photos) 
                            : leadData.before_photos;
                    } else if (leadData.report && leadData.report.breakdown) {
                        rawPhotos = leadData.report.breakdown;
                    }

                    if (Array.isArray(rawPhotos)) {
                        beforePhotosUrls = rawPhotos.map(item => (typeof item === 'object' && item.img) ? item.img : item).filter(Boolean);
                    }
                    
                    leadClientName = leadData.full_name || leadData.customer_name || "N/A";
                    leadClientPhone = leadData.phone || leadData.customer_phone || leadData.phone_number || "N/A";
                    leadPrice = leadData.package_price || leadData.service_cost || "N/A";
                    leadPay = leadData.contractor_pay || leadData.contractor_expense || "N/A";
                    
                    // NEW: Prioritize detailer_notes map to match the quote server output
                    leadAiNotes = leadData.detailer_notes || leadData.ai_notes || (leadData.report && leadData.report.detailer_notes) || "N/A";
                    
                    if (leadData.deel_contract_id) {
                        req.body.deelContractId = leadData.deel_contract_id;
                    }
                }
            } catch (e) {
                console.error("Could not fetch CRM lead data for QA:", e);
            }
        }

        const aiReport = await runQAAnalysis(filesData, details, beforePhotosUrls);

        const alreadyPaid = reports.some(r => r.jobId === details.jobId && r.bonusPaid === true);
        let bonusPaidOut = false;

        if (alreadyPaid) {
            console.warn(`SECURITY: Payout already issued for Job ${details.jobId}. Blocking duplicate payment attempt.`);
            bonusPaidOut = true; 
        } else if (aiReport.score > 6.9 ) { 
            const deelContractId = req.body.deelContractId; 
            
            let dynamicPayAmount = 0;
            const payMatches = String(leadPay).match(/\d+(\.\d+)?/g);
            if (payMatches) {
                dynamicPayAmount = payMatches.reduce((sum, val) => sum + parseFloat(val), 0);
            }
            
            if (deelContractId && !isNaN(dynamicPayAmount) && dynamicPayAmount > 0) {
                if (dynamicPayAmount >= 300) {
                    console.error(`SAFETY FLAG: Auto-payout of $${dynamicPayAmount} for Job ${details.jobId} hits the $300 limit. Blocked for manual admin review.`);
                } else {
                    const deelDescription = `Job ID: ${details.jobId} | Vehicle: ${details.vehicleYear} ${details.vehicleMake} ${details.vehicleModel} | Package: ${details.detailType} (Level ${details.serviceLevel}) | QA Score: ${aiReport.score}`;

                    issueDeelBonus(
                        deelContractId, 
                        dynamicPayAmount, 
                        deelDescription
                    );
                    bonusPaidOut = true;
                }
            } else {
                console.warn(`Contractor scored ${aiReport.score}, but missing Deel Contract ID or valid Pay Amount (${leadPay}).`);
            }
        }

        const formattedAnalysis = details.labels.map((label, index) => {
            let feedback = "No specific feedback provided by AI.";
            
            if (aiReport.analysis && Array.isArray(aiReport.analysis)) {
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
                img: '/uploads/' + path.basename(filesData[index]?.path || '')
            };
        });

        const reportData = {
            id: Date.now().toString(),
            jobId: details.jobId,
            bonusPaid: bonusPaidOut,
            timestamp: new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }),
            contractor: details.contractorName,
            vehicle: `${details.vehicleYear} ${details.vehicleMake} ${details.vehicleModel}`,
            detailType: details.detailType,
            serviceLevel: details.serviceLevel,
            score: aiReport.score,
            summary: aiReport.summary,
            analysis: formattedAnalysis,
            clientName: leadClientName,
            price: leadPrice,
            contractorPay: leadPay,
            aiNotes: leadAiNotes,
            beforePhotos: beforePhotosUrls
        };

        reports.unshift(reportData);
        fs.writeFileSync(dataFilePath, JSON.stringify(reports));

        // --- RETELL AI OUTBOUND CALL TRIGGER ---
        // Fire asynchronously to avoid blocking the response to the user
        if (leadClientPhone !== "N/A" && RETELL_QA_AGENT_ID !== "YOUR_QA_AGENT_ID") {
            console.log(`Triggering Retell Post-Inspection Call to ${leadClientPhone}`);
            fetch(`${RETELL_SERVICE_URL}/trigger-inspection-call`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customer_name: leadClientName,
                    phone: leadClientPhone,
                    vehicle: `${details.vehicleYear} ${details.vehicleMake} ${details.vehicleModel}`,
                    agent_id: RETELL_QA_AGENT_ID
                })
            }).catch(err => console.error("Failed to reach Python Retell service:", err));
        }

        res.json({
            score: aiReport.score,
            summary: aiReport.summary,
            analysis: formattedAnalysis
        });

    } catch (e) {
        console.error("QA Scan Error:", e);
        res.status(500).json({ error: true, message: e.message });
    } finally {
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
    
    // Delete the saved images from the hard drive (updated to target the persistent disk)
    if (report && report.analysis) {
        report.analysis.forEach(item => {
            if (item.img) {
                const fileName = path.basename(item.img);
                const filePath = path.join(uploadDir, fileName);
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
```eof

### 2. The Python updates (`retell_sms_service (2).py`)
I've added the `/trigger-inspection-call` endpoint right after your existing outbound marketing endpoint. This is what the Node.js server will ping to officially trigger the call with Retell.

```python:retell_sms_service (2).py
from flask import Flask, request, jsonify
from twilio.rest import Client
import os
import requests  
import math
from datetime import datetime, timedelta
from flask_cors import CORS

# 1. Initialize the Flask App
app = Flask(__name__)
CORS(app)

# --- Configuration ---
account_sid = os.environ.get("TWILIO_ACCOUNT_SID")
auth_token = os.environ.get("TWILIO_AUTH_TOKEN")
twilio_phone_number = os.environ.get("TWILIO_CUSTOMER_SMS_NUMBER") or os.environ.get("TWILIO_PHONE_NUMBER")
RETELL_API_SECRET = os.environ.get("RETELL_API_SECRET", "retell-secret-key-2024")
CALENDAR_SERVER_URL = os.environ.get("CALENDAR_SERVER_URL", "https://calendar-system-l6vb.onrender.com")
# --- Configuration (Add these lines) ---
CRM_BASE_URL = os.environ.get("CRM_BASE_URL", "https://michie-detailing-backend.onrender.com")
CRM_ADMIN_API_KEY = os.environ.get("CRM_ADMIN_API_KEY", "YOURPASSWORDHERE")

if account_sid and auth_token:
    client = Client(account_sid, auth_token)
else:
    client = None

def clean_phone_number(phone_str):
    """Normalizes phone numbers to the last 10 digits for matching."""
    if not phone_str: return ""
    return "".join(filter(str.isdigit, str(phone_str)))[-10:]

# =====================================================================
def extract_payload(data):
    """
    Robust helper to unpack JSON payloads sent from different environments.
    Handles flat payloads, 'args' wraps, 'data' wraps, or double-wrapped test tool scenarios.
    """
    if not isinstance(data, dict):
        return {}
    
    # Step 1: Unpack Axios "data" wrapper if present
    if "data" in data and isinstance(data["data"], dict):
        data = data["data"]
        
    # Step 2: Unpack "args" wrappers. 
    # A while loop is used because Retell's Test Tool natively double-wraps parameters
    while "args" in data and isinstance(data["args"], dict):
        data = data["args"]
        
    return data

# ROUTE ZERO - OUTBOUND MARKETING FOR SAAS SOFTWARE
# OUTBOUND CALL FOR MARKETING AI SAAS SERVICE

# Your Retell API Key (Get this from your Retell Dashboard)
RETELL_API_KEY = os.environ.get("RETELL_API_KEY")

@app.route('/trigger-outbound-call', methods=['POST'])
def trigger_outbound_call():
    data = request.get_json() or {}
    
    # Data coming from your partners.html form
    customer_name = data.get("name") # Fixed typo: custor_name to customer_name based on context
    customer_phone = data.get("phone")
    company_name = data.get("company")
    agent_id = data.get("agent_id") # agent_b714b81d98ef2755323d724833

    # 1. Format the phone number (Retell needs +1 for US)
    # This uses your existing clean_phone_number function
    clean_phone = "".join(filter(str.isdigit, str(customer_phone)))[-10:]
    formatted_phone = f"+1{clean_phone}"

    # 2. Prepare the Retell API Request
    # We pass 'retell_llm_dynamic_variables' so the AI knows the user's name
    url = "https://api.retellai.com/v2/create-phone-call"
    
    payload = {
        "from_number": "+14055614330", # Must be a number bought/verified in Retell
        "to_number": formatted_phone,
        "override_agent_id": agent_id,
        "retell_llm_dynamic_variables": {
            "customer_name": customer_name,
            "company_name": company_name
        }
    }

    headers = {
        "Authorization": f"Bearer {RETELL_API_KEY}",
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(url, json=payload, headers=headers)
        if response.status_code == 201 or response.status_code == 200:
            return jsonify({"status": "success", "call_id": response.json().get("call_id")}), 200
        else:
            return jsonify({"error": response.text}), response.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500
# END OF AI MARKETING SAAS SERVICE

# NEW ROUTE - POST-INSPECTION QA FOLLOW UP CALL
# =====================================================================
@app.route('/trigger-inspection-call', methods=['POST'])
def trigger_inspection_call():
    """Triggered by Node.js QA server when a contractor completes an inspection."""
    data = request.get_json() or {}
    
    customer_name = data.get("customer_name", "Customer")
    customer_phone = data.get("phone")
    vehicle = data.get("vehicle", "your vehicle")
    agent_id = data.get("agent_id") 

    if not customer_phone or not agent_id:
        return jsonify({"error": "Phone and agent_id are required"}), 400

    clean_phone = "".join(filter(str.isdigit, str(customer_phone)))[-10:]
    formatted_phone = f"+1{clean_phone}"

    url = "https://api.retellai.com/v2/create-phone-call"
    payload = {
        "from_number": "+14055614330", # Verified Retell Outbound Number
        "to_number": formatted_phone,
        "override_agent_id": agent_id,
        "retell_llm_dynamic_variables": {
            "customer_name": customer_name,
            "vehicle": vehicle
        }
    }

    headers = {
        "Authorization": f"Bearer {RETELL_API_KEY}",
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(url, json=payload, headers=headers)
        if response.status_code in [200, 201]:
            return jsonify({"status": "success", "call_id": response.json().get("call_id")}), 200
        else:
            return jsonify({"error": response.text}), response.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ROUTE 1: Fetch Lead Data (RETELL TOOL)
# =====================================================================
@app.route('/fetch-lead-data', methods=['POST'])
def fetch_lead_data():
    # Security Check
    auth_header = request.headers.get('Authorization')
    if not auth_header or auth_header != f"Bearer {RETELL_API_SECRET}":
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json() or {}
    payload = data.get("args") if "args" in data else data
    phone = payload.get("phone")

    if not phone:
        return jsonify({"error": "Phone number is required"}), 400

    try:
        # Fetch from your Node.js Quoting tool
        leads_url = "https://quote.michieauto.com/admin/leads"
        response = requests.get(leads_url, timeout=10)
        
        if response.status_code == 200:
            leads = response.json()
            clean_target = clean_phone_number(phone)
            
            # Search for the specific lead
            client_lead = next((l for l in leads if clean_target in clean_phone_number(l.get('phone', ''))), None)
            
            if client_lead:
                report = client_lead.get('report', {})
                return jsonify({
                    "status": "success",
                    "name": client_lead.get('client'),
                    "vehicle": client_lead.get('vehicle'),
                    "price": report.get('price'),
                    "package": report.get('name'),
                    "summary": report.get('summary'),
                    "booking_link": f"https://quote.michieauto.com/book?quote_id={client_lead.get('id')}"
                }), 200
                
        return jsonify({"error": "Lead not found"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# =====================================================================
# =====================================================================
# ROUTE: Send Post-Call Summary to Owner (RETELL TOOL)
# =====================================================================
@app.route('/send-owner-summary', methods=['POST'])
def send_owner_summary():
    auth_header = request.headers.get('Authorization')
    if not auth_header or auth_header != f"Bearer {RETELL_API_SECRET}":
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json() or {}
    
    # FIX: Use the robust extractor you defined earlier in the file
    payload = extract_payload(data)

    # FIX: Added 'customer_phone' to match your Retell JSON schema
    customer_name = payload.get("customer_name") or payload.get("name") or "Unknown"
    phone_raw = payload.get("customer_phone") or payload.get("phone") or payload.get("phone_number") or "Unknown"
    call_reason = payload.get("call_reason") or payload.get("summary") or "Not provided"
    booking_made = payload.get("booking_made") or "No"

    OWNER_PHONE_NUMBER = "+14052238171" 

    try:
        message_body = (
            f"📞 NEW CALL SUMMARY\n"
            f"Name: {customer_name}\n"
            f"Phone: {phone_raw}\n"
            f"Booking Made: {booking_made}\n"
            f"Reason: {call_reason}"
        )

        if client:
            client.messages.create(
                to=OWNER_PHONE_NUMBER,
                from_=twilio_phone_number,
                body=message_body
            )
            return jsonify({"status": "success", "message": "Summary sent to owner!"}), 200
        else:
            return jsonify({"error": "Twilio client not initialized"}), 500

    except Exception as e:
        print(f"Error sending SMS: {e}")
        return jsonify({"error": str(e)}), 500

# ROUTE 2: Send SMS
# =====================================================================
@app.route('/send-sms', methods=['POST'])
def send_retell_sms():
    auth_header = request.headers.get('Authorization')
    if not auth_header or auth_header != f"Bearer {RETELL_API_SECRET}":
        return jsonify({"error": "Unauthorized"}), 401

    if not client:
        return jsonify({"error": "Twilio client not initialized."}), 500

    data = request.get_json() or {}
    payload = data.get("args") if "args" in data else data

    to_phone_number = payload.get('to')
    message_body = payload.get('message_body')

    try:
        message = client.messages.create(
            to=to_phone_number,
            from_=twilio_phone_number,
            body=message_body
        )
        return jsonify({"message": "SMS sent successfully!", "sid": message.sid}), 200
    except Exception as e:
        return jsonify({"error": f"Failed to send SMS: {str(e)}"}), 500

# =====================================================================
# ROUTE 3: Check Calendar Availability
# =====================================================================
@app.route('/check-availability', methods=['POST'])
def check_availability():
    auth_header = request.headers.get('Authorization')
    if not auth_header or auth_header != f"Bearer {RETELL_API_SECRET}":
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json() or {}
    payload = data.get("args") if "args" in data else data
    
    today = datetime.now().date()
    date_str = payload.get('date') or today.strftime('%Y-%m-%d')
    
    try:
        target_url = f"{CALENDAR_SERVER_URL.rstrip('/')}/api/available_slots"
        response = requests.get(target_url, params={"date": date_str}, timeout=10)
        
        if response.status_code == 200:
            return jsonify({
                "checked_date": date_str,
                "availability": response.json()
            }), 200
        else:
            return jsonify({"error": "Calendar server error."}), response.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# NEW TOOL: Send Booking Link (The one you requested)
# =====================================================================
@app.route('/send-booking-link', methods=['POST'])
def send_booking_link():
    auth_header = request.headers.get('Authorization')
    if not auth_header or auth_header != f"Bearer {RETELL_API_SECRET}":
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json() or {}
    payload = data.get("args", data)
    phone = payload.get("phone")

    if not phone:
        return jsonify({"error": "Phone number required"}), 400

    try:
        # 1. Look up the lead one more time to get the name and vehicle
        response = requests.get("https://quote.michieauto.com/admin/leads", timeout=10)
        leads = response.json()
        target = clean_phone_number(phone)
        match = next((l for l in leads if target in clean_phone_number(l.get('phone', ''))), None)

        if not match:
            return jsonify({"error": "Cannot send link: Lead not found"}), 404

        # 2. Extract details
        first_name = match.get('client', 'Customer').split(' ')[0]
        vehicle = match.get('vehicle', 'vehicle')
        booking_url = f"https://quote.michieauto.com/book?quote_id={match.get('id')}"

        # 3. Construct the exact message you requested
        # Note: I used $40 off to match the code 'VIPCLIENT' in your book.html
        message_body = f"Hey {first_name}, here's the link to book your appointment for your {vehicle}. Use code 'VIPCLIENT' and get $40 off! {booking_url}"

        # 4. Send via Twilio
        clean_to = "+1" + target
        client.messages.create(
            to=clean_to,
            from_=twilio_phone_number,
            body=message_body
        )

        return jsonify({"status": "success", "message": "Booking link sent!"}), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500

# =====================================================================
# ROUTE 5: Send Appointment Confirmation Text (RETELL TOOL)
# =====================================================================
@app.route('/send-appointment-confirmation', methods=['POST'])
def send_appointment_confirmation():
    # Security Check to make sure only your Retell AI can trigger this
    auth_header = request.headers.get('Authorization')
    if not auth_header or auth_header != f"Bearer {RETELL_API_SECRET}":
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json() or {}
    payload = data.get("args", data)  # Retell wraps tool arguments inside 'args'
    
    phone_raw = payload.get("phone")
    name = payload.get("first_name", "[NAME]")
    service = payload.get("service", "[Package selected]")
    date_raw = payload.get("date")  # Format expected: YYYY-MM-DD
    time_raw = payload.get("time")  # Format expected: HH:MM (24-hour style)

    if not phone_raw:
        return jsonify({"error": "Phone number is required"}), 400

    # 1. Format the Date and Time cleanly to match notify.html output
    formatted_date = '[MM/DD/YYYY]'
    if date_raw:
        try:
            # Handles converting YYYY-MM-DD to MM/DD/YYYY
            dt = datetime.strptime(date_raw, "%Y-%m-%d")
            formatted_date = dt.strftime("%m/%d/%Y")
        except ValueError:
            formatted_date = date_raw

    formatted_time = '[Time IN 12 hour AM OR PM FORMAT]'
    if time_raw:
        try:
            # Handles converting 24-hour style (e.g. 14:00) to 12-hour style (2:00 PM)
            dt_time = datetime.strptime(time_raw, "%H:%M")
            formatted_time = dt_time.strftime("%I:%M %p").lstrip('0')
        except ValueError:
            formatted_time = time_raw

    # 2. Construct the exact long-form text script layout from your notify.html file
    message_body = (
        f"Hi {name} it's Michie Auto Detailing, Thanks for booking with us, "
        f"your {service} detail is confirmed for {formatted_date} at {formatted_time}\n\n"
        f"Here's a few reminders for your appointment:\n\n"
        f"Please remove all important valuables, personal items, documents out of your vehicle before we start detailing. "
        f"(This includes all gold cash & jewelry, personal documents and registration paperwork) if there is trash you'd like us to throw away, leave it inside!\n\n"
        f"Note: We will use your residence's power outlet for our shampooer and our detail equipment. "
        f"Please direct us upon arrival where we should go to connect to the power. We have an extension cable to connect to any outlet outside.\n\n"
        f"The detail process can take anywhere from 1-4 hours and you keep the keys! You do not need to be there the entire time while we detail.\n\n"
        f"IMPORTANT: When we're finished up, we ask before we leave that you check everything over as we care ❤️ about making our clients cars look awesome and meeting your expectations. "
        f"If we need to correct something, please let us know before we leave. Return trips will result in a $100 transportation fee charged.\n\n"
        f"Your booking includes (1) free reschedule. If you need to change your appointment date or time please let us know ASAP so we can get you our soonest available slot.\n\n"
        f"And lastly, if you have any questions or concerns call our 24/7 support line at (405) 295-5189\n\n"
        f"Thank you for booking with us!\nMichie Auto Detail\nhttps://michieauto.com\n(405) 295-5189"
    )

    # 3. Process the phone number format
    clean_target = clean_phone_number(phone_raw)
    formatted_phone = f"+1{clean_target}"

    # 4. Dispatch directly to your live notification server engine
    notification_engine_url = "https://client-notifications.onrender.com/send-sms"
    
    # We send the structure exactly as notify.html javascript maps it out
    dispatch_payload = {
        "password": "okc2manila!", # Authenticates automatically with your gate password
        "to": formatted_phone,
        "message_body": message_body
    }

    try:
        response = requests.post(notification_engine_url, json=dispatch_payload, timeout=10)
        if response.ok:
            return jsonify({"status": "success", "message": "Confirmation text dispatched successfully!"}), 200
        else:
            return jsonify({"error": f"Notification server rejected request: {response.text}"}), response.status_code
    except Exception as e:
        return jsonify({"error": f"Failed to reach dispatch server: {str(e)}"}), 500

# NEW ROUTE: View-Only CRM Search (RETELL TOOL)
# =====================================================================
@app.route('/search-crm', methods=['POST'])
def search_crm():
    """Allows Retell AI to search the CRM for appointments without modifying data."""
    auth_header = request.headers.get('Authorization')
    if not auth_header or auth_header != f"Bearer {RETELL_API_SECRET}":
        return jsonify({"error": "Unauthorized"}), 401
        
    data = request.get_json() or {}
    payload = data.get("args", data)
    
    phone = payload.get("phone")
    name = payload.get("name")
        
    try:
        leads_url = f"{CRM_BASE_URL.rstrip('/')}/admin/leads"
        # Uses your existing GET /admin/leads from app.py
        resp = requests.get(leads_url, headers=get_crm_headers(), timeout=10)
        
        if not resp.ok:
            return jsonify({"error": f"CRM backend error: {resp.status_code}"}), 500
            
        leads = resp.json()
        matches = []
        
        clean_target_phone = clean_phone_number(phone) if phone else None
        
        for l in leads:
            match = False
            record_phone = clean_phone_number(l.get('customer_phone', ''))
            record_name = str(l.get('customer_name', '')).lower()
            
            if clean_target_phone and clean_target_phone in record_phone:
                match = True
            if name and name.lower() in record_name:
                match = True
                
            if match:
                matches.append({
                    "lead_id": l.get("id"),
                    "customer_name": l.get("customer_name"),
                    "customer_phone": l.get("customer_phone"),
                    "vehicle": f"{l.get('vehicle_year','')} {l.get('vehicle_make','')} {l.get('vehicle_model','')}".strip(),
                    "appointment_date": l.get("appointment_date"),
                    "appointment_time": l.get("appointment_time"),
                    "service_level": l.get("service_level"),
                    "status": l.get("status"),
                    "job_notes": l.get("job_notes")
                })
                
        return jsonify({"status": "success", "results": matches}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# =====================================================================
# --- Helper Functions ---
def clean_phone_number(phone_str):
    if not phone_str: return ""
    return "".join(filter(str.isdigit, str(phone_str)))[-10:]

def get_crm_headers():
    """Returns the mandatory headers to bypass the @admin_required lock in app.py"""
    return {
        "Content-Type": "application/json",
        "X-Admin-API-Key": CRM_ADMIN_API_KEY
    }

# NEW ROUTE 7: Create Booking Directly (RETELL TOOL)
# =====================================================================
@app.route('/create-interior-booking', methods=['POST'])
def create_interior_booking():
    """
    Enables Retell AI to book flat-rate interior packages on behalf of the customer.
    Collects parameters, calculates pricing/commission, posts to the CRM, and dispatches the payment text.
    """
    auth_header = request.headers.get('Authorization')
    if not auth_header or auth_header != f"Bearer {RETELL_API_SECRET}":
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json() or {}
    payload = extract_payload(data)

    # Required parameters
    full_name = payload.get("full_name")
    email = payload.get("email")
    phone_raw = payload.get("phone")
    address = payload.get("address")
    zip_code = payload.get("zip_code")
    vehicle_year = payload.get("vehicle_year")
    vehicle_make = payload.get("vehicle_make")
    vehicle_model = payload.get("vehicle_model")
    date_str = payload.get("date")          # Expected format: YYYY-MM-DD
    time_str = payload.get("time")          # Expected format: HH:MM (24-hour style)
    package_level_raw = payload.get("package_level")  # 1, 2, or 3
    vehicle_type = payload.get("vehicle_type")    # 'Car', 'Truck', or 'SUV'
    promo_code = (payload.get("promo_code") or "").strip().lower()
    job_notes = payload.get("job_notes", "")

    # Highly Descriptive Validation: Detect exactly which values are missing
    required_fields = {
        "full_name": full_name,
        "email": email,
        "phone": phone_raw,
        "address": address,
        "zip_code": zip_code,
        "vehicle_year": vehicle_year,
        "vehicle_make": vehicle_make,
        "vehicle_model": vehicle_model,
        "date": date_str,
        "time": time_str,
        "package_level": package_level_raw,
        "vehicle_type": vehicle_type
    }
    
    missing_fields = [field for field, val in required_fields.items() if not val]
    
    if missing_fields:
        return jsonify({
            "error": "Missing required fields for direct booking.",
            "missing_fields": missing_fields,
            "received_payload": data,
            "extracted_payload": payload
        }), 400

    # Strict type cast to int for package_level to avoid string evaluation mismatch downstream
    try:
        package_level = int(package_level_raw)
    except (ValueError, TypeError):
        return jsonify({"error": "Package level must be a valid integer (1, 2, or 3)."}), 400

    if package_level not in [1, 2, 3]:
        return jsonify({"error": "Package level must be 1, 2, or 3."}), 400

    if vehicle_type.lower() not in ['car', 'truck', 'suv']:
        return jsonify({"error": "Vehicle type must be 'Car', 'Truck', or 'SUV'."}), 400

    # 1. Base Prices determined by booking site specifications
    prices_map = {
        'car': {1: 199, 2: 249, 3: 349},
        'truck': {1: 219, 2: 299, 3: 379},
        'suv': {1: 219, 2: 299, 3: 379}
    }
    
    # Standard original base price
    base_price = prices_map[vehicle_type.lower()][package_level]
    final_price = base_price
    is_promo_active = False

    # 2. Check and Apply Promo Code (12% for Lvl 1, 18% for Lvl 2, 19% for Lvl 3)
    if promo_code == "vipclient":
        is_promo_active = True
        discounts = {1: 0.12, 2: 0.18, 3: 0.19}
        final_price = int(math.floor(base_price * (1.0 - discounts[package_level])))

    # 3. Formulate Contractor Pay: 50% of (package price minus 70)
    contractor_pay_amount = (float(final_price) - 70.0) * 0.50
    contractor_pay_str = f"${contractor_pay_amount:.2f} + TIPS"

    # Define standard package naming convention
    package_type = f"Interior Level {package_level}"
    clean_target = clean_phone_number(phone_raw)
    formatted_phone = f"+1{clean_target}"

    # 4. Construct payload for CRM Backend Insertion
    crm_payload = {
        "full_name": full_name,
        "email": email,
        "phone": formatted_phone,
        "address": address,
        "zip_code": zip_code,
        "vehicle_year": str(vehicle_year),
        "vehicle_make": vehicle_make,
        "vehicle_model": vehicle_model,
        "date": date_str,
        "time": time_str,
        "package_type": package_type,
        "package_price": str(final_price),
        "vehicle_type": vehicle_type.capitalize(),
        "job_notes": job_notes,
        "contractor_pay": contractor_pay_str,
        "deal_name": f"{package_type} - {vehicle_make}"
    }

    # 5. Get Payment Checkout Link Mapping exactly as defined in interior.html
    payment_link = "https://pay.michieauto.com/deposit"  # fallback
    vt = vehicle_type.capitalize()
    
    if is_promo_active:
        if vt == 'Car':
            if package_level == 1: payment_link = "https://pay.michieauto.com/vipsinterior26"
            elif package_level == 2: payment_link = "https://pay.michieauto.com/vipsinteriorlvl2s"
            elif package_level == 3: payment_link = "https://pay.michieauto.com/vipsinteriorlvl3s"
        elif vt == 'Truck':
            if package_level == 1: payment_link = "https://pay.michieauto.com/vipsinteriorlvl1truck"
            elif package_level == 2: payment_link = "https://pay.michieauto.com/vipsinteriorlvl2truck"
            elif package_level == 3: payment_link = "https://pay.michieauto.com/vipsinteriorlvl3truck"
        else: # SUV / Fallback
            if package_level == 1: payment_link = "https://pay.michieauto.com/vipsinteriorlvl1suv"
            elif package_level == 2: payment_link = "https://pay.michieauto.com/vipsinteriorlvl2suv"
            elif package_level == 3: payment_link = "https://pay.michieauto.com/vipsinteriorlvl3suv"
    else:
        if vt == 'Car':
            if package_level == 1: payment_link = "https://pay.michieauto.com/springinteriorlvl1s"
            elif package_level == 2: payment_link = "https://pay.michieauto.com/springinteriorlvl2s"
            elif package_level == 3: payment_link = "https://pay.michieauto.com/springinteriorlvl3s"
        elif vt == 'Truck':
            if package_level == 1: payment_link = "https://pay.michieauto.com/springinteriorlvl1truck"
            elif package_level == 2: payment_link = "https://pay.michieauto.com/springinteriorlvl2truck"
            elif package_level == 3: payment_link = "https://pay.michieauto.com/springinteriorlvl3truck"
        else: # SUV / Fallback
            if package_level == 1: payment_link = "https://pay.michieauto.com/springinteriorlvl1suv"
            elif package_level == 2: payment_link = "https://pay.michieauto.com/springinteriorlvl2suv"
            elif package_level == 3: payment_link = "https://pay.michieauto.com/springinteriorlvl3suv"

    try:
        # Submit booking to CRM Backend
        crm_endpoint = f"{CRM_BASE_URL.rstrip('/')}/public/appointment"
        crm_resp = requests.post(crm_endpoint, json=crm_payload, timeout=10)
        
        if not crm_resp.ok:
            return jsonify({"error": f"CRM rejected the appointment: {crm_resp.text}"}), crm_resp.status_code

        # 6. Send the pending booking warning SMS to client
        first_name = full_name.split(' ')[0]
        sms_message = (
            f"ACTION REQUIRED: Hi {first_name}, it's Michie Auto Detail. "
            f"Your {package_type} for the {vehicle_make} {vehicle_model} is PENDING. "
            f"Payment is required IMMEDIATELY to secure your spot. "
            f"Pay here: {payment_link} Questions? (405) 295-5189"
        )
        
        notification_engine_url = "https://client-notifications.onrender.com/send-sms"
        dispatch_payload = {
            "password": "okc2manila!",
            "to": formatted_phone,
            "message_body": sms_message
        }
        
        # Post SMS to dispatch server
        requests.post(notification_engine_url, json=dispatch_payload, timeout=10)

        return jsonify({
            "status": "success",
            "message": "Appointment posted and payment link dispatched via text!",
            "payload_sent": crm_payload,
            "payment_link": payment_link,
            "price_charged": final_price,
            "is_discounted": is_promo_active
        }), 200

    except Exception as e:
        return jsonify({"error": f"An error occurred while building or saving the booking: {str(e)}"}), 500


@app.route('/retell-webhook', methods=['POST'])
def retell_webhook():
    data = request.get_json() or {}
    call_info = data.get('call') or data.get('data') or {}
    
    # Configuration
    BILLY_AGENT_ID = "agent_d28d1b0d00496a5bb43c138605"
    DEBRIEF_AGENT_ID = "agent_7751c8d1e8972546b8dfaa6dc2" 
    OWNER_PHONE = "+14052238171" # <--- UPDATED FROM +14054009701 TO +14052238171
    RETELL_OUTBOUND_NUMBER = "+14055614330"

    incoming_agent_id = call_info.get('agent_id')
    event_type = data.get('event')

    # 1. Loop Protection: Ignore calls made by the debrief agent itself
    if incoming_agent_id == DEBRIEF_AGENT_ID:
        return jsonify({"status": "ignored"}), 200

    # 2. ONLY trigger when the call analysis is finished
    if event_type != 'call_analyzed':
        return jsonify({"status": "ignored", "message": "Waiting for analysis"}), 200

    # 3. EXTRACT DATA
    analysis = call_info.get('call_analysis', {})
    custom_data = analysis.get('custom_analysis_data', {})
    
    # Capture Phone Numbers
    cust_phone_raw = call_info.get('from_number') or call_info.get('to_number')
    clean_cust_phone = "+1" + "".join(filter(str.isdigit, str(cust_phone_raw)))[-10:]

    # Capture Summary and Vehicle Details
    call_summary = analysis.get('call_summary') or "No summary available."
    cust_name = custom_data.get('customer_name') or "Unknown Name"
    
    # Combine Vehicle Year, Make, and Model if they exist in your custom analysis
    v_year = custom_data.get('vehicle_year') or ""
    v_make = custom_data.get('vehicle_make') or ""
    v_model = custom_data.get('vehicle_model') or "Vehicle not specified"
    full_vehicle = f"{v_year} {v_make} {v_model}".strip()

    # --- ACTION 1: SEND THE SMS IMMEDIATELY ---
    # This ensures you get the info even if you miss the call.
    try:
        if client:
            sms_body = (
                f"📞 NEW CALL SUMMARY\n"
                f"👤 Name: {cust_name}\n"
                f"🚗 Vehicle: {full_vehicle}\n"
                f"📱 Caller ID: {clean_cust_phone}\n\n"
                f"📝 Summary: {call_summary}"
            )
            client.messages.create(
                to=OWNER_PHONE,
                from_=twilio_phone_number,
                body=sms_body
            )
            print(f"DEBUG: SMS Summary sent to {OWNER_PHONE}")
    except Exception as e:
        print(f"ERROR: Failed to send SMS debrief: {e}")

    # --- ACTION 2: TRIGGER THE DEBRIEF CALL ---
    # (The existing logic to have the AI call you)
    print(f"DEBUG: Triggering Debrief Call for: {cust_name}")
    
    url = "https://api.retellai.com/v2/create-phone-call"
    payload = {
        "from_number": RETELL_OUTBOUND_NUMBER,
        "to_number": OWNER_PHONE,
        "override_agent_id": DEBRIEF_AGENT_ID,
        "retell_llm_dynamic_variables": {
            "customer_name": cust_name,
            "vehicle": full_vehicle,
            "customer_phone": clean_cust_phone,
            "call_summary": call_summary 
        }
    }
    headers = {
        "Authorization": f"Bearer {os.environ.get('RETELL_API_KEY')}",
        "Content-Type": "application/json"
    }

    requests.post(url, json=payload, headers=headers)
    
    return jsonify({"status": "success"}), 200

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port)
```eof

Make sure to set the `RETELL_SERVICE_URL` environment variable on the QA app to point to your Python server and provide the `RETELL_QA_AGENT_ID`. This is set up so it won't crash your server or hold up the loading screen if the outbound call fails. Let me know if you want to tweak what it says to the customer!

<!-- ... existing code ... -->
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
                    
                    // SECURITY: Hydrate the contract ID directly from your database so it can't be spoofed by the frontend
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
        // Check if a report for this specific job already exists and was paid
        const existingReport = reports.find(r => r.jobId === details.jobId);
        let bonusPaidOut = false;

        if (existingReport && existingReport.bonusPaid) {
            console.log(`Bonus already paid for Job ${details.jobId}. Skipping Deel API call.`);
            bonusPaidOut = true;
        } else if (aiReport.score >= 9.0) {
            // Securely mapped from the CRM fetch above
            const deelContractId = req.body.deelContractId; 
            
            // Clean the fetched string (e.g., "$120.00") and parse it as a valid Number
            const dynamicPayAmount = parseFloat(String(leadPay).replace(/[^0-9.]/g, ''));
            
            if (deelContractId && !isNaN(dynamicPayAmount) && dynamicPayAmount > 0) {
                // Do not 'await' so the frontend receives the AI report immediately
                issueDeelBonus(
                    deelContractId, 
                    dynamicPayAmount, 
                    `Job Completed: ${details.jobId} - QA Score: ${aiReport.score}`
                );
                bonusPaidOut = true;
            } else {
                console.warn(`Contractor scored ${aiReport.score}, but missing Deel Contract ID or valid Pay Amount (${leadPay}).`);
            }
        }
        // -------------------------------------

        // Inject image URLs into the analysis breakdown for the admin portal
<!-- ... existing code ... -->

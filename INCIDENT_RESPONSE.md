# 🚨 INCIDENT RESPONSE PLAN
## MITRA EdTech Platform — CERT-In Compliance Document
**Version:** 2.0 | **Last Updated:** April 2025 | **Classification:** Internal Use Only

---

## 1. Purpose & Scope

This Incident Response Plan (IRP) establishes procedures for detecting, responding to, and recovering from cybersecurity incidents affecting the MITRA platform, in compliance with:

- **CERT-In Directions 2022** — Mandatory reporting within **6 hours** of detection
- **Digital Personal Data Protection Act (DPDP Act) 2023** — Data breach notification
- **IT Act 2000** — Section 43A (reasonable security practices)
- **NIC Security Policy** (for government-hosted infrastructure)

---

## 2. Incident Classification

| Severity | Type | Examples | Response SLA |
|----------|------|----------|-------------|
| **P0 — Critical** | Data breach, ransomware, system takeover | Student PII exposed, admin credentials compromised | 1 hour |
| **P1 — High** | Unauthorized access, service disruption | Brute-force attack, API abuse, DDoS | 4 hours |
| **P2 — Medium** | Policy violation, suspicious activity | Unusual login patterns, failed MFA attempts | 24 hours |
| **P3 — Low** | Minor issues | Misconfiguration, single failed login | 72 hours |

---

## 3. Incident Response Team

| Role | Responsibility | Contact |
|------|---------------|---------|
| Incident Commander | Overall coordination | ciso@mitra.gov.in |
| Security Engineer | Technical containment & forensics | security@mitra.gov.in |
| DPO (Data Protection Officer) | DPDP Act compliance & notification | dpo@mitra.gov.in |
| Communications Lead | Internal & external notifications | comms@mitra.gov.in |
| Legal Counsel | Legal obligations & liability | legal@mitra.gov.in |

**Emergency Hotline:** +91-XXXX-XXXXXX (24×7)

---

## 4. CERT-In Mandatory Reporting (6-Hour Rule)

Per the **CERT-In Directions 2022** (April 2022), the following incidents MUST be reported to CERT-In within **6 hours** of detection:

```
CERT-In Incident Reporting Portal: https://www.cert-in.org.in/
Email: incident@cert-in.org.in
Phone: 1800-11-4949 (Toll Free)
```

### Reportable Incident Categories:
- Targeted scanning/probing of critical networks
- Compromise of critical systems (servers, databases)
- Ransomware attacks
- Phishing attacks targeting users
- Malicious code (malware, virus, spyware)
- DDoS attacks
- Data breaches involving personal data
- Attacks on IoT/OT devices
- **Any breach involving children's educational data**

### Report Format (CERT-In Compliant):
```json
{
  "incident_type": "",
  "detection_time": "YYYY-MM-DDTHH:MM:SSZ",
  "reporting_time": "YYYY-MM-DDTHH:MM:SSZ",
  "affected_systems": [],
  "estimated_impact": "",
  "actions_taken": [],
  "organization": "MITRA EdTech Platform",
  "poc_name": "",
  "poc_email": "",
  "poc_phone": ""
}
```

---

## 5. Response Procedures

### Phase 1: Identification (0–30 minutes)
- [ ] Alert received via monitoring system / user report
- [ ] Assign Incident ID: `INC-YYYY-MM-DD-###`
- [ ] Classify severity (P0–P3)
- [ ] Notify Incident Commander
- [ ] Begin incident log

### Phase 2: Containment (30 min – 2 hours)
- [ ] Isolate affected systems from network
- [ ] Revoke compromised credentials immediately
- [ ] Block malicious IPs at firewall/CDN level
- [ ] Enable enhanced logging
- [ ] Preserve forensic evidence (disk images, logs)
- [ ] Notify CERT-In if P0/P1 (must be within 6 hours of detection)

### Phase 3: Eradication (2–24 hours)
- [ ] Identify root cause
- [ ] Remove malware/malicious access
- [ ] Patch vulnerabilities
- [ ] Rotate all potentially compromised secrets
- [ ] Verify no backdoors remain

### Phase 4: Recovery (24–72 hours)
- [ ] Restore from clean backup
- [ ] Verify system integrity
- [ ] Enable monitoring
- [ ] Phased service restoration
- [ ] Notify affected users (DPDP Act §7)

### Phase 5: Post-Incident (72 hours – 30 days)
- [ ] Prepare detailed incident report
- [ ] Root cause analysis
- [ ] Update security controls
- [ ] User awareness training if applicable
- [ ] Update this IRP if needed
- [ ] Submit final report to CERT-In (within 30 days)

---

## 6. Data Breach Notification (DPDP Act 2023)

**If personal data is breached:**

1. **Internal notification:** DPO within 1 hour
2. **CERT-In notification:** Within 6 hours (per CERT-In Directions 2022)
3. **Board notification:** Within 24 hours
4. **Affected individuals:** As soon as practicable (within 72 hours)
5. **Data Protection Board (DPDP §8):** Within 72 hours once established

### Notification Template:
```
Subject: MITRA Data Breach Notification — [DATE]

Dear [User/Authority],

We are writing to inform you of a security incident that may affect your data.

WHAT HAPPENED: [Brief description]
WHEN: [Date/time detected]
WHAT DATA: [Types of data potentially affected]
WHAT WE'VE DONE: [Actions taken]
WHAT YOU SHOULD DO: [User actions recommended]
FOR MORE INFORMATION: dpo@mitra.gov.in | +91-XXXX-XXXXXX
```

---

## 7. Security Controls (CERT-In 2022 — Section 3)

### Mandatory Controls Implemented:
- [x] **System Clock Synchronisation** — All servers synced to NTP (STQC)
- [x] **Log Retention** — 180 days minimum for all audit/security logs
- [x] **VPN/Secure Access** — All admin access requires MFA + VPN
- [x] **Password Policy** — Min 8 chars, complexity, 90-day rotation for admins
- [x] **Software Inventory** — Maintained and updated quarterly
- [x] **Virtual Asset Logging** — Cloud resources tagged and logged

---

## 8. Forensic Evidence Preservation

Per CERT-In requirements, preserve the following for minimum **180 days**:
- System logs (application, server, database, firewall)
- Authentication logs (login attempts, MFA events)
- Network flow logs
- User activity audit trails
- API access logs

**Storage:** Tamper-proof, encrypted, separate from production systems

---

## 9. Backup & Recovery

| System | Backup Frequency | RTO | RPO | Location |
|--------|-----------------|-----|-----|---------|
| PostgreSQL DB | Every 6 hours | 4 hours | 6 hours | Mumbai + Hyderabad |
| AR Asset Storage | Daily | 24 hours | 24 hours | S3-compatible |
| Config/Secrets | On change | 1 hour | 0 | Vault encrypted |

---

## 10. Annual Review

This document must be reviewed and updated:
- Annually (April of each year)
- After any P0/P1 incident
- When significant system changes occur
- When CERT-In issues new directions

**Next Review Date:** April 2026

---

## 11. References

- CERT-In Directions, April 2022: https://www.cert-in.org.in
- Digital Personal Data Protection Act 2023: https://meity.gov.in/dpdpa
- IT Act 2000 (as amended): https://meity.gov.in
- NCERT Data Guidelines: https://ncert.nic.in
- NIC Security Policy: https://nic.in/security

---

*This document is classified as INTERNAL USE ONLY. Do not share with unauthorised personnel.*

**Approved by:** Chief Information Security Officer, MITRA Platform  
**Document ID:** MITRA-IRP-2025-001

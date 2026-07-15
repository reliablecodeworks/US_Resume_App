import { useState, useEffect, useCallback, useMemo } from "react";

// Filename parts keep spaces, hyphens and accents; only characters the filesystem
// actually rejects are dropped. This is what names the downloaded file — the API's
// Content-Disposition header is ignored, because the download goes through a blob: URL.
const sanitizeFilenamePart = (str) =>
  Array.from(String(str ?? ""))
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join("")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");

const buildResumeFilename = (name, role, company) =>
  `${sanitizeFilenamePart(name)}-${sanitizeFilenamePart(role)}-${sanitizeFilenamePart(company)}.pdf`;

// Memoize static styles outside component
const containerStyle = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  padding: "40px 20px"
};

const cardStyle = {
  maxWidth: "800px",
  width: "100%",
  background: "#fff",
  borderRadius: "20px",
  boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
  padding: "50px"
};

const titleStyle = {
  fontSize: "36px",
  fontWeight: "bold",
  color: "#333",
  marginBottom: "10px",
  textAlign: "center"
};

const subtitleStyle = {
  fontSize: "16px",
  color: "#666",
  marginBottom: "40px",
  textAlign: "center"
};

const labelStyle = {
  display: "block",
  fontSize: "14px",
  fontWeight: "600",
  color: "#333",
  marginBottom: "8px"
};

const inputBaseStyle = {
  width: "100%",
  padding: "14px 16px",
  fontSize: "16px",
  border: "2px solid #e0e0e0",
  borderRadius: "12px",
  outline: "none",
  transition: "all 0.3s"
};

const selectStyle = {
  ...inputBaseStyle,
  cursor: "pointer"
};

const textareaStyle = {
  ...inputBaseStyle,
  resize: "vertical",
  fontFamily: "inherit",
  fontSize: "15px"
};

const infoBoxStyle = {
  marginTop: "30px",
  padding: "20px",
  background: "#f8f9fa",
  borderRadius: "12px",
  border: "1px solid #e0e0e0"
};

const infoTitleStyle = {
  fontSize: "16px",
  fontWeight: "600",
  color: "#333",
  marginBottom: "12px"
};

const infoListStyle = {
  fontSize: "14px",
  color: "#666",
  lineHeight: "1.8",
  paddingLeft: "20px",
  margin: 0
};

const footerStyle = {
  marginTop: "30px",
  textAlign: "center",
  fontSize: "14px",
  color: "#999"
};

export default function Home() {
  const [profiles, setProfiles] = useState([]);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [jd, setJd] = useState("");
  const [disable, setDisable] = useState(false);

  // Load profiles on mount
  useEffect(() => {
    fetch("/api/profiles")
      .then(res => res.json())
      .then(data => setProfiles(data))
      .catch(err => console.error("Failed to load profiles:", err));
  }, []);

  // Memoize selected profile data
  const selectedProfileData = useMemo(() => {
    return profiles.find(p => p.id === selectedProfile);
  }, [profiles, selectedProfile]);

  // Memoize button style based on disable state
  const buttonStyle = useMemo(() => ({
    width: "100%",
    padding: "16px",
    fontSize: "18px",
    fontWeight: "bold",
    color: "#fff",
    background: disable ? "#ccc" : "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    border: "none",
    borderRadius: "12px",
    cursor: disable ? "not-allowed" : "pointer",
    transition: "all 0.3s",
    boxShadow: disable ? "none" : "0 4px 15px rgba(102, 126, 234, 0.4)"
  }), [disable]);

  // Memoize generatePDF function with useCallback
  const generatePDF = useCallback(async () => {
    if (disable) return;
    if (!selectedProfile) return alert("Please select a profile");
    if (!jd) return alert("Please enter the Job Description");
    if (!company) return alert("Please enter the Company Name");
    if (!role) return alert("Please enter the Role Name");

    setDisable(true);

    try {
      const genRes = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          profile: selectedProfile,
          jd: jd,
          company: company,
          role: role
        })
      });

      if (!genRes.ok) {
        const errorText = await genRes.text();
        console.error('Error response:', errorText);
        
        // Try to parse as JSON to get detailed error
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.locationType === 'hybrid') {
            alert("⚠️ HYBRID POSITION DETECTED\n\nThis job requires some office days. This tool is designed for REMOTE-ONLY positions.\n\nPlease provide a fully remote job description.");
            setDisable(false);
            return;
          } else if (errorJson.locationType === 'onsite') {
            alert("⚠️ ONSITE/IN-PERSON POSITION DETECTED\n\nThis job is not remote. This tool is designed for REMOTE-ONLY positions.\n\nPlease provide a fully remote job description.");
            setDisable(false);
            return;
          }
          if (errorJson.locationType === 'entry-level') {
            alert("⚠️ ENTRY LEVEL POSITION DETECTED\n\nThis job is ENTRY LEVEL. This tool is designed for MID-LEVEL and SENIOR positions. Please provide a more senior job description.");
            setDisable(false);
            return;
          }
          throw new Error(errorJson.error || "Failed to generate PDF");
        } catch (e) {
          throw new Error(errorText || "Failed to generate PDF");
        }
      }

      const blob = await genRes.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      
      // [Profile name]-[Role]-[Company].pdf
      const profileName = selectedProfileData ? selectedProfileData.name : selectedProfile;
      const filename = buildResumeFilename(profileName, role, company);

      a.download = filename;
      a.click();
      window.URL.revokeObjectURL(url);

      alert("✅ Resume generated successfully!");
    } catch (error) {
      alert(`❌ Error: ${error.message}`);
    } finally {
      setDisable(false);
    }
  }, [disable, selectedProfile, jd, company, role, selectedProfileData]);

  // Memoize handlers to prevent re-renders
  const handleProfileChange = useCallback((e) => setSelectedProfile(e.target.value), []);
  const handleCompanyChange = useCallback((e) => setCompany(e.target.value), []);
  const handleRoleChange = useCallback((e) => setRole(e.target.value), []);
  const handleJdChange = useCallback((e) => setJd(e.target.value), []);

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h1 style={titleStyle}>
          🚀 AI Resume Tailor
        </h1>
        <p style={subtitleStyle}>
          Select your profile, paste the job description, and get an ATS-optimized resume in seconds!
        </p>

        {/* Profile Selection */}
        <div style={{ marginBottom: "30px" }}>
          <label style={labelStyle}>
            Select Profile <span style={{ color: "#e74c3c" }}>*</span>
          </label>
          <select
            value={selectedProfile}
            onChange={handleProfileChange}
            style={selectStyle}
          >
            <option value="">-- Select a profile --</option>
            {profiles.map(profile => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: "30px" }}>
          <label style={labelStyle}>
            Company Name <span style={{ color: "#e74c3c" }}>*</span>
          </label>
          <input
            type="text"
            value={company}
            onChange={handleCompanyChange}
            placeholder="e.g., Google, Amazon..."
            style={inputBaseStyle}
          />
        </div>

        <div style={{ marginBottom: "30px" }}>
          <label style={labelStyle}>
            Role Name <span style={{ color: "#e74c3c" }}>*</span>
          </label>
          <input
            type="text"
            value={role}
            onChange={handleRoleChange}
            placeholder="e.g., Senior Software Engineer, Product Manager..."
            style={inputBaseStyle}
          />
        </div>

        {/* Job Description */}
        <div style={{ marginBottom: "30px" }}>
          <label style={labelStyle}>
            Job Description <span style={{ color: "#e74c3c" }}>*</span>
          </label>
          <textarea
            value={jd}
            onChange={handleJdChange}
            placeholder="Paste the full job description here... (requirements, responsibilities, qualifications)"
            rows="12"
            style={textareaStyle}
          />
        </div>

        {/* Generate Button */}
        <button
          onClick={generatePDF}
          disabled={disable}
          style={buttonStyle}
        >
          {disable ? "⏳ Generating Resume (30-45 seconds)..." : "✨ Generate Tailored Resume"}
        </button>

        {/* Info Box */}
        <div style={infoBoxStyle}>
          <h3 style={infoTitleStyle}>
            💡 How it works:
          </h3>
          <ul style={infoListStyle}>
            <li>Select your profile (name, contacts, work history, education)</li>
            <li>Paste the job description you're applying for</li>
            <li>AI analyzes JD and generates: title, summary, skills, experience bullets</li>
            <li>Download ATS-optimized PDF resume tailored to the job!</li>
          </ul>
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <p style={{ margin: 0 }}>
            Powered by OpenAI GPT • ATS Score: 95-100%
          </p>
        </div>
      </div>
    </div>
  );
}

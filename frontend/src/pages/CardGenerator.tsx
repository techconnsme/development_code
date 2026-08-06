import React, { useState, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Download } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';

export default function CardGenerator() {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [address, setAddress] = useState('');
  const [website, setWebsite] = useState('');
  const [color, setColor] = useState('#2563eb');
  const [flipped, setFlipped] = useState(false);
  const [logoSrc, setLogoSrc] = useState('');
  const frontRef = useRef<SVGSVGElement>(null);
  const backRef = useRef<SVGSVGElement>(null);

  const { data: companyData } = useQuery({
    queryKey: ['company'],
    queryFn: () => api('/company'),
  });

  React.useEffect(() => {
    if (companyData) {
      setCompany(companyData.name || '');
      setAddress(companyData.address || '');
      setEmail(companyData.email || '');
      setPhone(companyData.phone || '');
      setWebsite(companyData.website || '');
      if (companyData.logo_url) setLogoSrc(companyData.logo_url);
    }
  }, [companyData]);

  const downloadCard = useCallback(() => {
    const svg = flipped ? backRef.current : frontRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const svgData = new XMLSerializer().serializeToString(clone);
    const canvas = document.createElement('canvas');
    canvas.width = 1050;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, 1050, 600);
      const a = document.createElement('a');
      a.download = `名片_${name || company}_${flipped ? '背面' : '正面'}.png`;
      a.href = canvas.toDataURL('image/png');
      a.click();
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
  }, [flipped, name, company]);

  // Truncate text for SVG (estimate ~6px per char at fontSize 10-11)
  const trunc = (s: string, max: number) => s.length > max ? s.slice(0, max - 1) + '…' : s;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">{tr('Card Generator', '名片生成器 Card Generator', '名片生成器 Card Generator')}</h2>
        <p className="text-muted-foreground mt-1">{tr('Auto-generate business cards from company info', '根據公司資料自動產生名片', '根据公司资料自动产生名片')}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Form */}
        <div className="bg-card border rounded-xl p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">姓名 Name</label>
              <input value={name} onChange={e => setName(e.target.value)}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm mt-0.5" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">職稱 Title</label>
              <input value={title} onChange={e => setTitle(e.target.value)}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm mt-0.5" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">公司 Company</label>
              <input value={company} onChange={e => setCompany(e.target.value)}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm mt-0.5" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">電話 Phone</label>
              <input value={phone} onChange={e => setPhone(e.target.value)}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm mt-0.5" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">電郵 Email</label>
              <input value={email} onChange={e => setEmail(e.target.value)}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm mt-0.5" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">網站 Website</label>
              <input value={website} onChange={e => setWebsite(e.target.value)}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm mt-0.5" />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground">地址 Address</label>
              <input value={address} onChange={e => setAddress(e.target.value)}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm mt-0.5" />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">主題色</label>
            <div className="flex gap-2 mt-1">
              {['#2563eb', '#dc2626', '#16a34a', '#7c3aed', '#0891b2', '#ea580c', '#334155'].map(c => (
                <button key={c} onClick={() => setColor(c)}
                  className={`w-8 h-8 rounded-full border-2 ${color === c ? 'border-foreground scale-110' : 'border-transparent'}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={downloadCard}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm hover:opacity-90">
              <Download className="h-4 w-4" /> {tr('Download', '下載', '下载')} {flipped ? tr('Back', '背面', '背面') : tr('Front', '正面', '正面')} PNG
            </button>
            {!flipped && (
              <button onClick={() => { setFlipped(true); setTimeout(() => { const svg = backRef.current; if (svg) { const clone = svg.cloneNode(true) as SVGSVGElement; clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); const svgData = new XMLSerializer().serializeToString(clone); const canvas = document.createElement('canvas'); canvas.width = 1050; canvas.height = 600; const ctx = canvas.getContext('2d'); if (ctx) { const img = new Image(); img.onload = () => { ctx.drawImage(img, 0, 0, 1050, 600); const a = document.createElement('a'); a.download = `名片_${name || company}_背面.png`; a.href = canvas.toDataURL('image/png'); a.click(); }; img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData))); } } }, 100); }}
                className="flex items-center gap-2 border px-4 py-2 rounded-md text-sm hover:bg-muted">
                <Download className="h-4 w-4" /> {tr('Download Back', '下載背面', '下载背面')}
              </button>
            )}
          </div>
        </div>

        {/* Preview */}
        <div className="space-y-4">
          <div className="flex gap-2">
            <button onClick={() => setFlipped(false)} className={`px-3 py-1 text-sm rounded-md ${!flipped ? 'bg-primary text-primary-foreground' : 'border'}`}>正面</button>
            <button onClick={() => setFlipped(true)} className={`px-3 py-1 text-sm rounded-md ${flipped ? 'bg-primary text-primary-foreground' : 'border'}`}>背面</button>
          </div>

          <div className="border rounded-xl p-4 bg-muted/20 flex justify-center">
            {!flipped ? (
              <svg ref={frontRef} width="525" height="300" viewBox="0 0 525 300" xmlns="http://www.w3.org/2000/svg">
                <rect width="525" height="300" rx="12" fill="white" stroke="#e5e7eb" strokeWidth="1"/>
                <rect x="0" y="0" width="8" height="300" rx="4" fill={color}/>
                {logoSrc && <image href={logoSrc} x="380" y="20" width="120" height="48" preserveAspectRatio="xMidYMid meet" />}
                <text x="36" y="55" fontSize="22" fontWeight="bold" fill="#1f2937">{name || 'Your Name'}</text>
                <text x="36" y="78" fontSize="13" fill={color} fontWeight="500">{title || 'Job Title'}</text>
                <line x1="36" y1="98" x2="200" y2="98" stroke="#e5e7eb" strokeWidth="1"/>
                <text x="36" y="125" fontSize="14" fontWeight="600" fill="#374151">{company || 'Company Name'}</text>
                {phone && <text x="36" y="165" fontSize="11" fill="#6b7280">Tel: {trunc(phone, 40)}</text>}
                {email && <text x="36" y="190" fontSize="11" fill="#6b7280">{trunc(email, 45)}</text>}
                {website && <text x="36" y="215" fontSize="11" fill="#6b7280">{trunc(website, 50)}</text>}
                {address && <text x="36" y="250" fontSize="10" fill="#9ca3af">{trunc(address, 55)}</text>}
              </svg>
            ) : (
              <svg ref={backRef} width="525" height="300" viewBox="0 0 525 300" xmlns="http://www.w3.org/2000/svg">
                <rect width="525" height="300" rx="12" fill={color}/>
                {logoSrc && <image href={logoSrc} x="212" y="80" width="100" height="40" preserveAspectRatio="xMidYMid meet" />}
                <text x="262" y={logoSrc ? '145' : '130'} fontSize="28" fontWeight="bold" fill="white" textAnchor="middle">{company || 'Company'}</text>
                {website && <text x="262" y={logoSrc ? '175' : '160'} fontSize="12" fill="rgba(255,255,255,0.8)" textAnchor="middle">{trunc(website, 40)}</text>}
                {phone && <text x="262" y={logoSrc ? '200' : '185'} fontSize="11" fill="rgba(255,255,255,0.7)" textAnchor="middle">{trunc(phone, 35)}</text>}
                {address && <text x="262" y={logoSrc ? '220' : '205'} fontSize="10" fill="rgba(255,255,255,0.5)" textAnchor="middle">{trunc(address, 50)}</text>}
              </svg>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

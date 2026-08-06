import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ChevronLeft, ChevronRight, Plus, X, CalendarDays, Columns, Clock, CalendarRange, Download } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';

const COLORS = ['#2563eb','#dc2626','#16a34a','#ca8a04','#9333ea','#0891b2','#db2777','#4f46e5'];
const HOURS = Array.from({ length: 15 }, (_, i) => i + 7); // 7am - 9pm

function weekdayLabel(i: number): string {
  const labels = [
    ['Sun', '日', '日'], ['Mon', '一', '一'], ['Tue', '二', '二'],
    ['Wed', '三', '三'], ['Thu', '四', '四'], ['Fri', '五', '五'], ['Sat', '六', '六'],
  ];
  return tr(labels[i][0], labels[i][1], labels[i][2]);
}

function eventTypeLabel(type: string): string {
  const labels: Record<string, [string, string, string]> = {
    appointment: ['Appointment', '約會', '约会'],
    meeting:      ['Meeting', '會議', '会议'],
    deadline:     ['Deadline', '截止', '截止'],
    reminder:     ['Reminder', '提醒', '提醒'],
    invoice_due:  ['Invoice Due', '發票到期', '发票到期'],
  };
  const l = labels[type];
  return l ? tr(l[0], l[1], l[2]) : type;
}

function fmt(d: Date) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function fmtTime(d: Date) { return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }

export default function CalendarPage() {
  const queryClient = useQueryClient();
  const today = new Date();
  const [view, setView] = useState<'year'|'month'|'week'|'day'>('month');
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [weekStart, setWeekStart] = useState(() => {
    const d = new Date(today); d.setDate(d.getDate() - d.getDay()); return d;
  });
  const [dayDate, setDayDate] = useState(() => new Date(today));
  const [showForm, setShowForm] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<{type: string; id: string; number: string} | null>(null);
  const [form, setForm] = useState({ title: '', description: '', event_type: 'appointment', start_time: '', end_time: '', all_day: 0, customer_id: '', color: '#2563eb', location: '' });

  // Compute date range
  const range = useMemo(() => {
    if (view === 'year') {
      return { start: `${year}-01-01`, end: `${year}-12-31` };
    } else if (view === 'month') {
      const lastDay = new Date(year, month + 1, 0).getDate();
      return { start: `${year}-${String(month+1).padStart(2,'0')}-01`, end: `${year}-${String(month+1).padStart(2,'0')}-${lastDay}` };
    } else if (view === 'week') {
      const end = new Date(weekStart); end.setDate(end.getDate() + 6);
      return { start: fmt(weekStart), end: fmt(end) };
    } else {
      return { start: fmt(dayDate), end: fmt(dayDate) };
    }
  }, [view, year, month, weekStart, dayDate]);

  const { data: events } = useQuery({
    queryKey: ['calendar-events', range.start, range.end],
    queryFn: () => api(`/calendar/events?start=${range.start}&end=${range.end}`),
  });

  const { data: invoicesData } = useQuery({
    queryKey: ['calendar-invoices', range.start, range.end],
    queryFn: () => api(`/invoices?limit=500`),
    select: (d: any) => (d?.data || []).filter((inv: any) => {
      const d1 = inv.issue_date || inv.due_date;
      return d1 >= range.start && d1 <= range.end;
    }),
  });

  const { data: poData } = useQuery({
    queryKey: ['calendar-pos', range.start, range.end],
    queryFn: () => api(`/purchase-orders?limit=500`),
    select: (d: any) => (d?.data || []).filter((po: any) => {
      const d1 = po.issue_date || po.due_date;
      return d1 >= range.start && d1 <= range.end;
    }),
  });

  const { data: customers } = useQuery({
    queryKey: ['customers-list-cal'],
    queryFn: () => api('/customers?limit=200'),
  });

  const createMut = useMutation({
    mutationFn: (body: any) => api('/calendar/events', { method: 'POST', body }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['calendar-events'] }); setShowForm(false); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/calendar/events/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['calendar-events'] }),
  });

  const openNew = (dateStr: string, timeStr?: string) => {
    setForm({ title: '', description: '', event_type: 'appointment',
      start_time: timeStr ? `${dateStr}T${timeStr}` : `${dateStr}T09:00`,
      end_time: timeStr ? `${dateStr}T${String(parseInt(timeStr)+1).padStart(2,'0')}:00` : `${dateStr}T10:00`,
      all_day: timeStr ? 0 : 1, customer_id: '', color: '#2563eb', location: '' });
    setShowForm(true);
  };

  const evList = (events?.data || []);
  const handleEventClick = (e: any, ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (e._type === 'invoice') {
      setPdfPreview({ type: 'invoice', id: e._ref.id, number: e._ref.invoice_number });
    } else if (e._type === 'po') {
      setPdfPreview({ type: 'purchase-order', id: e._ref.id, number: e._ref.po_number });
    } else {
      const refType = e.reference_type;
      const refId = e.reference_id;
      if (refType === 'invoice' && refId) {
        setPdfPreview({ type: 'invoice', id: refId, number: '' });
      } else if (refType === 'document' && refId) {
        // navigate away — skip for now
      } else {
        if (confirm(`刪除「${e.title}」?`)) deleteMut.mutate(e.id);
      }
    }
  };

  // ── Navigation ──
  const nav = (dir: -1|1) => {
    if (view === 'year') {
      setYear(y => y + dir);
    } else if (view === 'month') {
      const m = month + dir;
      if (m < 0) { setYear(y => y-1); setMonth(11); }
      else if (m > 11) { setYear(y => y+1); setMonth(0); }
      else setMonth(m);
    } else if (view === 'week') {
      const d = new Date(weekStart); d.setDate(d.getDate() + dir * 7); setWeekStart(d);
    } else {
      const d = new Date(dayDate); d.setDate(d.getDate() + dir); setDayDate(d);
    }
  };

  const title = view === 'year'
    ? `${year} 年`
    : view === 'month'
    ? `${year} 年 ${month + 1} 月`
    : view === 'week'
    ? `${fmt(weekStart)} — ${fmt(new Date(new Date(weekStart).setDate(weekStart.getDate()+6)))}`
    : `${dayDate.getFullYear()} 年 ${dayDate.getMonth()+1} 月 ${dayDate.getDate()} 日 ${weekdayLabel(dayDate.getDay())}`;

  // ── Month helpers ──
  const lastDay = new Date(year, month + 1, 0).getDate();
  const firstDow = new Date(year, month, 1).getDay();
  const getDayEvents = (day: number) => {
    const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const calEvents = evList.filter((e: any) => e.start_time?.startsWith(ds));
    const invEvents = (invoicesData || []).filter((inv: any) => (inv.issue_date === ds || inv.due_date === ds))
      .map((inv: any) => ({ id: `inv-${inv.id}`, title: `賣 ${inv.invoice_number}`, color: '#16a34a', _type: 'invoice', _ref: inv }));
    const poEvents = (poData || []).filter((po: any) => (po.issue_date === ds || po.due_date === ds))
      .map((po: any) => ({ id: `po-${po.id}`, title: `買 ${po.po_number}`, color: '#dc2626', _type: 'po', _ref: po }));
    return [...calEvents, ...invEvents, ...poEvents];
  };

  // ── Week helpers ──
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart); d.setDate(d.getDate() + i); return d;
  });
  const getHourEvents = (date: Date, hour: number) => {
    const ds = fmt(date);
    return evList.filter((e: any) => {
      if (!e.start_time) return false;
      const [ed, et] = e.start_time.split('T');
      return ed === ds && parseInt(et) >= hour && parseInt(et) < hour + 1;
    });
  };
  const weekAllDay = (date: Date) => {
    const ds = fmt(date);
    const calAllDay = evList.filter((e: any) => e.all_day && e.start_time?.startsWith(ds));
    const invEvents = (invoicesData || []).filter((inv: any) => (inv.issue_date === ds || inv.due_date === ds))
      .map((inv: any) => ({ id: `inv-${inv.id}`, title: `賣 ${inv.invoice_number}`, color: '#16a34a', _type: 'invoice' }));
    const poEvents = (poData || []).filter((po: any) => (po.issue_date === ds || po.due_date === ds))
      .map((po: any) => ({ id: `po-${po.id}`, title: `買 ${po.po_number}`, color: '#dc2626', _type: 'po' }));
    return [...calAllDay, ...invEvents, ...poEvents];
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">日曆 Calendar</h2>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            <span>排程與買賣狀況</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-green-600 inline-block" />賣 Invoice</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-600 inline-block" />買 Purchase</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* View toggle */}
          <div className="flex bg-muted rounded-md p-0.5">
            <button onClick={() => setView('year')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${view === 'year' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              <CalendarRange className="h-3.5 w-3.5 inline mr-1" />年
            </button>
            <button onClick={() => setView('month')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${view === 'month' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              <CalendarDays className="h-3.5 w-3.5 inline mr-1" />月
            </button>
            <button onClick={() => setView('week')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${view === 'week' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              <Columns className="h-3.5 w-3.5 inline mr-1" />週
            </button>
            <button onClick={() => setView('day')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${view === 'day' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              <Clock className="h-3.5 w-3.5 inline mr-1" />日
            </button>
          </div>
          <button onClick={() => nav(-1)} className="p-1.5 hover:bg-muted rounded"><ChevronLeft className="h-5 w-5" /></button>
          <span className="font-semibold min-w-[180px] text-center text-sm">{title}</span>
          <button onClick={() => nav(1)} className="p-1.5 hover:bg-muted rounded"><ChevronRight className="h-5 w-5" /></button>
          <button onClick={() => openNew(fmt(today), '09:00')}
            className="flex items-center gap-1.5 bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-sm hover:opacity-90">
            <Plus className="h-4 w-4" /> 新增
          </button>
        </div>
      </div>

      {/* ── Year View ── */}
      {view === 'year' && (
        <div className="grid grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 12 }, (_, mi) => {
            const mLastDay = new Date(year, mi + 1, 0).getDate();
            const mFirstDow = new Date(year, mi, 1).getDay();
            return (
              <div key={mi} className="bg-card border rounded-xl p-3 cursor-pointer hover:shadow-sm transition-shadow"
                onClick={() => { setMonth(mi); setView('month'); }}>
                <div className="text-sm font-semibold text-center mb-2">{tr(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mi], `${mi + 1} 月`, `${mi + 1} 月`)}</div>
                <div className="grid grid-cols-7 gap-px text-center">
                  {[0,1,2,3,4,5,6].map(i => <div key={i} className="text-[9px] text-muted-foreground">{weekdayLabel(i)}</div>)}
                  {Array.from({ length: 42 }, (_, di) => {
                    const dn = di - mFirstDow + 1;
                    const inM = dn >= 1 && dn <= mLastDay;
                    if (!inM) return <div key={di} />;
                    const ds = `${year}-${String(mi+1).padStart(2,'0')}-${String(dn).padStart(2,'0')}`;
                    const hasCal = evList.some((e: any) => e.start_time?.startsWith(ds));
                    const hasInv = (invoicesData || []).some((inv: any) => inv.issue_date === ds || inv.due_date === ds);
                    const hasPo = (poData || []).some((po: any) => po.issue_date === ds || po.due_date === ds);
                    const isToday = year === today.getFullYear() && mi === today.getMonth() && dn === today.getDate();
                    return (
                      <div key={di} className="relative flex items-center justify-center">
                        <span className={`text-[10px] ${isToday ? 'font-bold text-primary' : ''}`}>{dn}</span>
                        {(hasCal || hasInv || hasPo) && (
                          <span className="absolute bottom-0 flex gap-px">
                            {hasInv && <span className="w-1 h-1 rounded-full bg-green-600" />}
                            {hasPo && <span className="w-1 h-1 rounded-full bg-red-600" />}
                            {hasCal && !hasInv && !hasPo && <span className="w-1 h-1 rounded-full bg-blue-600" />}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Month View ── */}
      {view === 'month' && (
        <div className="bg-card border rounded-xl overflow-hidden">
          <div className="grid grid-cols-7">
            {[0,1,2,3,4,5,6].map(i => (
              <div key={i} className="p-2 text-center text-xs font-medium text-muted-foreground border-b bg-muted/30">{weekdayLabel(i)}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {Array.from({ length: 42 }, (_, i) => {
              const dayNum = i - firstDow + 1;
              const inMonth = dayNum >= 1 && dayNum <= lastDay;
              const dayEvents = inMonth ? getDayEvents(dayNum) : [];
              const isToday = inMonth && year === today.getFullYear() && month === today.getMonth() && dayNum === today.getDate();
              return (
                <div key={i} className={`min-h-[90px] border-b border-r p-1.5 ${inMonth ? 'hover:bg-muted/30 cursor-pointer' : 'bg-muted/10 text-muted-foreground/50'}`}
                  onClick={() => inMonth && openNew(`${year}-${String(month+1).padStart(2,'0')}-${String(dayNum).padStart(2,'0')}`, '09:00')}>
                  <div className={`text-xs mb-1 ${isToday ? 'bg-primary text-primary-foreground w-5 h-5 flex items-center justify-center rounded-full font-bold' : 'font-medium'}`}>{inMonth ? dayNum : ''}</div>
                  <div className="space-y-0.5">
                    {dayEvents.slice(0, 3).map((e: any) => (
                      <div key={e.id} title={e.title} className="text-xs truncate rounded px-1 py-0.5 cursor-pointer hover:opacity-80"
                        style={{ backgroundColor: e.color + '20', color: e.color, borderLeft: `3px solid ${e.color}` }}
                        onClick={(ev) => handleEventClick(e, ev)}>
                        {e.all_day ? '' : (e.start_time?.split('T')[1]?.slice(0, 5) || '') + ' '}{e.title}
                      </div>
                    ))}
                    {dayEvents.length > 3 && <div className="text-xs text-muted-foreground">+{dayEvents.length - 3}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Week View ── */}
      {view === 'week' && (
        <div className="bg-card border rounded-xl overflow-hidden">
          {/* Day headers */}
          <div className="grid grid-cols-8 border-b bg-muted/30">
            <div className="p-2 text-center text-xs font-medium text-muted-foreground border-r w-16" />
            {weekDays.map((d, i) => {
              const isToday = fmt(d) === fmt(today);
              const ad = weekAllDay(d);
              return (
                <div key={i} className={`p-2 text-center border-r last:border-r-0 ${isToday ? 'bg-primary/5' : ''}`}>
                  <div className="text-xs text-muted-foreground">{weekdayLabel(d.getDay())}</div>
                  <div className={`text-lg font-semibold ${isToday ? 'text-primary' : ''}`}>{d.getDate()}</div>
                  {ad.length > 0 && (
                    <div className="mt-0.5 space-y-0.5">
                      {ad.slice(0, 2).map((e: any) => (
                        <div key={e.id} title={e.title} className="text-[10px] truncate rounded px-1 py-0.5 cursor-pointer hover:opacity-80" style={{ backgroundColor: e.color + '30', color: e.color }} onClick={(ev) => handleEventClick(e, ev)}>{e.title}</div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {/* Time grid */}
          <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 250px)' }}>
            {HOURS.map(hour => (
              <div key={hour} className="grid grid-cols-8 border-b border-muted/30 min-h-[60px]">
                <div className="p-1 text-[10px] text-muted-foreground text-right pr-2 border-r pt-0.5 w-16">
                  {String(hour).padStart(2,'0')}:00
                </div>
                {weekDays.map((d, di) => {
                  const he = getHourEvents(d, hour);
                  const isToday = fmt(d) === fmt(today);
                  return (
                    <div key={di} className={`border-r last:border-r-0 p-0.5 cursor-pointer hover:bg-muted/20 transition-colors ${isToday ? 'bg-primary/[0.02]' : ''}`}
                      onClick={() => openNew(fmt(d), `${String(hour).padStart(2,'0')}:00`)}>
                      {he.map((e: any) => (
                        <div key={e.id} title={`${e.title} — ${e.start_time?.split('T')[1]?.slice(0,5) || ''}`}
                          className="text-[10px] rounded px-1 py-0.5 mb-0.5 truncate cursor-pointer hover:opacity-80"
                          style={{ backgroundColor: e.color + '30', color: e.color, borderLeft: `3px solid ${e.color}` }}
                          onClick={(ev) => handleEventClick(e, ev)}>
                          {e.title}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Day View ── */}
      {view === 'day' && (
        <div className="bg-card border rounded-xl overflow-hidden">
          {/* Day header */}
          <div className="grid grid-cols-2 border-b bg-muted/30">
            <div className="p-3 text-center border-r">
              <div className="text-xs text-muted-foreground">{weekdayLabel(dayDate.getDay())}</div>
              <div className={`text-2xl font-bold ${fmt(dayDate) === fmt(today) ? 'text-primary' : ''}`}>{dayDate.getDate()}</div>
              {weekAllDay(dayDate).map((e: any) => (
                <div key={e.id} title={e.title} className="text-xs mt-1 truncate rounded px-2 py-0.5 cursor-pointer hover:opacity-80" style={{ backgroundColor: e.color + '30', color: e.color }} onClick={(ev) => handleEventClick(e, ev)}>{e.title}</div>
              ))}
            </div>
            <div className="p-3 flex flex-col justify-center text-sm text-muted-foreground">
              <div>{dayDate.getFullYear()} 年 {dayDate.getMonth()+1} 月</div>
              <div className="text-xs mt-1">{evList.filter((e: any) => e.start_time?.startsWith(fmt(dayDate))).length} 個事件</div>
            </div>
          </div>
          {/* Hourly slots */}
          <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 280px)' }}>
            {HOURS.map(hour => {
              const he = getHourEvents(dayDate, hour);
              return (
                <div key={hour} className="flex border-b border-muted/30 min-h-[56px] cursor-pointer hover:bg-muted/20 transition-colors"
                  onClick={() => openNew(fmt(dayDate), `${String(hour).padStart(2,'0')}:00`)}>
                  <div className="w-16 flex-shrink-0 p-1 text-[10px] text-muted-foreground text-right pr-2 border-r pt-0.5">
                    {String(hour).padStart(2,'0')}:00
                  </div>
                  <div className="flex-1 p-1">
                    {he.map((e: any) => (
                      <div key={e.id} title={`${e.title} — ${e.start_time?.split('T')[1]?.slice(0,5) || ''} → ${e.end_time?.split('T')[1]?.slice(0,5) || ''}`}
                        className="text-xs rounded px-2 py-1 mb-0.5 cursor-pointer hover:opacity-80"
                        style={{ backgroundColor: e.color + '25', color: e.color, borderLeft: `4px solid ${e.color}` }}
                        onClick={(ev) => handleEventClick(e, ev)}>
                        <span className="font-medium">{e.start_time?.split('T')[1]?.slice(0,5) || ''}</span> {e.title}
                        {e.description && <span className="text-muted-foreground ml-1">— {e.description}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Event Form Modal ── */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowForm(false)}>
          <div className="bg-card border rounded-xl p-6 w-full max-w-md mx-4 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg">新增事件</h3>
              <button onClick={() => setShowForm(false)}><X className="h-4 w-4" /></button>
            </div>
            <form onSubmit={e => { e.preventDefault(); createMut.mutate(form); }} className="space-y-3">
              <input required value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
                placeholder="事件標題 *" className="w-full px-3 py-2 border rounded-md bg-background text-sm" />
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="描述" className="w-full px-3 py-2 border rounded-md bg-background text-sm" rows={2} />
              <div className="grid grid-cols-2 gap-3">
                <select value={form.event_type} onChange={e => setForm({ ...form, event_type: e.target.value })}
                  className="px-3 py-2 border rounded-md bg-background text-sm">
                  {['appointment','meeting','deadline','reminder','invoice_due'].map(k => <option key={k} value={k}>{eventTypeLabel(k)}</option>)}
                </select>
                <select value={form.customer_id} onChange={e => setForm({ ...form, customer_id: e.target.value })}
                  className="px-3 py-2 border rounded-md bg-background text-sm">
                  <option value="">關聯客戶（可選）</option>
                  {(customers?.data || []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={form.all_day === 1} onChange={e => setForm({ ...form, all_day: e.target.checked ? 1 : 0 })} className="rounded" />
                <label className="text-sm">全天事件</label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input type="datetime-local" value={form.start_time} onChange={e => setForm({ ...form, start_time: e.target.value })}
                  className="px-3 py-2 border rounded-md bg-background text-sm" />
                <input type="datetime-local" value={form.end_time} onChange={e => setForm({ ...form, end_time: e.target.value })}
                  className="px-3 py-2 border rounded-md bg-background text-sm" />
              </div>
              <input value={form.location} onChange={e => setForm({ ...form, location: e.target.value })}
                placeholder="地點" className="w-full px-3 py-2 border rounded-md bg-background text-sm" />
              <div className="flex gap-2">
                {COLORS.map(c => (
                  <button key={c} type="button" onClick={() => setForm({ ...form, color: c })}
                    className={`w-7 h-7 rounded-full border-2 ${form.color === c ? 'border-foreground scale-110' : 'border-transparent'}`}
                    style={{ backgroundColor: c }} />
                ))}
              </div>
              <div className="flex gap-3 justify-end">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border rounded-md text-sm">取消</button>
                <button type="submit" className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">建立</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── PDF Preview Modal ── */}
      {pdfPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPdfPreview(null)}>
          <div className="bg-card border rounded-xl w-[85vw] max-w-[85vw] h-[85vh] mx-4 flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h3 className="font-bold text-sm">{pdfPreview.type === 'invoice' ? '發票' : '採購單'} {pdfPreview.number}</h3>
              <div className="flex items-center gap-2">
                <a href={`/api/pdf/${pdfPreview.type}/${pdfPreview.id}`} target="_blank"
                  className="flex items-center gap-1 text-xs text-primary hover:underline"><Download className="h-3.5 w-3.5" /> 下載 PDF</a>
                <button onClick={() => setPdfPreview(null)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <iframe src={`/api/pdf/${pdfPreview.type}/${pdfPreview.id}?inline`} className="w-full h-full" title="PDF Preview" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

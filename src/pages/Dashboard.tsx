import { fetchWithAuth } from "../lib/api.js";
import React, { useEffect, useState } from 'react';
import { Card } from '../components/ui/card.js';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { motion } from 'motion/react';
import { SystemLogs } from '../components/SystemLogs.js';
import { useProject } from '../context/ProjectContext.js';

export default function Dashboard() {
  const { currentProject } = useProject();
  const [metrics, setMetrics] = useState<any[]>([]);
  const [experiments, setExperiments] = useState<any[]>([]);
  const [scores, setScores] = useState({ securityScore: 0, resilienceScore: 0, health: 100 });

  useEffect(() => {
    // Fetch immediately when project changes
    let isFetching = false;
    const fetchDashboardData = async () => {
      if (isFetching) return;
      isFetching = true;
      try {
        const scoresRes = await fetchWithAuth('/api/control/metrics/scores');
        if (scoresRes.ok) {
          const data = await scoresRes.json();
          setScores(prev => ({...prev, securityScore: data.securityScore || 0, resilienceScore: data.resilienceScore || 0}));
        }

        const res = await fetchWithAuth('/api/control/metrics');
        if (res.ok) {
          const data = await res.json();
          setMetrics(data);
        }
        
        const expRes = await fetchWithAuth('/api/control/experiments');
        if (expRes.ok) {
          const expData = await expRes.json();
          setExperiments(expData);
        }
      } catch (err) {
        // Suppress network errors during hot reloads or server restarts
      } finally {
        isFetching = false;
      }
    };

    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 2000);
    return () => clearInterval(interval);
  }, [currentProject?.id]);

  const activeExp = experiments.find(e => e.status === 'RUNNING' || e.status === 'ANALYZING');

  // Group metrics by second for chart
  // Backend now returns pre-aggregated 1-second buckets with P50 and P95 latency
  const chartData = metrics.map(m => ({
    time: m.timestamp,
    latency: Number(m.latency) || 0, // P95
    p50: Number(m.p50) || 0          // P50
  })).slice(-30);

  const calculateHealth = () => {
    if (metrics.length === 0) return 100;
    const errors = metrics.filter(m => m.errorRate > 0).length;
    return Math.max(0, Math.round(((metrics.length - errors) / metrics.length) * 100));
  };
  const dynamicHealth = calculateHealth();

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="space-y-6 flex flex-col h-full"
    >
      <div className="grid grid-cols-3 gap-4">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <MetricCard title="Security Score" value={scores.securityScore.toString()} subtext="/100" progress={scores.securityScore} progressColor="bg-green-500" />
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <MetricCard title="Resilience Score" value={scores.resilienceScore.toString()} subtext="/100" progress={scores.resilienceScore} progressColor="bg-primary" />
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
          <MetricCard title="API Health" value={dynamicHealth.toString()} subtext="%" progress={dynamicHealth} progressColor="bg-blue-500" />
        </motion.div>
      </div>

      {activeExp && (
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-hover border border-primary/30 p-6 rounded-2xl"
        >
          <h3 className="text-primary font-bold mb-2 uppercase text-xs tracking-widest">Active Experiment: {activeExp.type.toUpperCase()}</h3>
          <p className="text-sm text-muted mb-4">
            Targeting Route ID: {activeExp.routeId}
          </p>
          <div className="w-full bg-base h-2 rounded-full overflow-hidden border border-subtle">
            <div className="bg-primary h-full w-2/3 animate-pulse" />
          </div>
        </motion.div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1 min-h-[300px]">
        <motion.div 
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
          className="bg-surface border border-subtle rounded-2xl flex flex-col overflow-hidden h-full"
        >
          <div className="px-4 py-3 border-b border-subtle bg-card flex justify-between items-center">
            <h2 className="text-xs font-bold uppercase tracking-widest text-primary">P95 Latency (ms)</h2>
            <span className="text-[10px] font-mono text-muted">LIVE TELEMETRY</span>
          </div>
          <div className="flex-1 p-6">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <XAxis dataKey="time" hide />
                <YAxis stroke="#4A4A4C" tick={{ fill: '#8E8E93', fontSize: 10 }} />
                <Tooltip contentStyle={{ backgroundColor: '#111113', borderColor: '#2A2A2C', color: '#E0E0E0' }} itemStyle={{ color: '#F27D26' }} />
                <Line type="monotone" dataKey="latency" name="P95 Latency" stroke="#F27D26" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="p50" name="P50 Latency" stroke="#4A4A4C" strokeWidth={2} dot={false} isAnimationActive={false} strokeDasharray="3 3" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </motion.div>
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}
          className="h-full flex flex-col"
        >
          <SystemLogs />
        </motion.div>
      </div>
    </motion.div>
  );
}

function MetricCard({ title, value, subtext, progress, progressColor }: { title: string, value: string, subtext?: string, progress?: number, progressColor?: string }) {
  return (
    <div className="bg-card border border-subtle p-4 rounded-2xl">
      <div className="text-[10px] uppercase text-muted font-bold mb-2">{title}</div>
      <div className="text-3xl font-mono text-strong">{value}{subtext && <span className="text-lg opacity-50 ml-1">{subtext}</span>}</div>
      {progress !== undefined && (
        <div className="mt-2 h-1 bg-border rounded-full overflow-hidden">
          <div className={`h-full ${progressColor || 'bg-green-500'}`} style={{ width: `${progress}%` }}></div>
        </div>
      )}
    </div>
  );
}

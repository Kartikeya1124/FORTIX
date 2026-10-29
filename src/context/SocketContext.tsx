import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

export type TelemetryConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'degraded' | 'disconnected' | 'failed';

export interface TelemetryEvent {
  eventId: string;
  projectId: string;
  sequence?: number;
  timestamp: number;
  eventType: string;
  payload: any;
}

interface SocketContextValue {
  socket: Socket | null;
  connectionState: TelemetryConnectionState;
  eventsReceived: number;
  eventsPerSec: number;
  lastEventTime: number | null;
  reconnectCount: number;
  lastError: string | null;
  recentEvents: TelemetryEvent[];
  latencyMs: number;
  pingServer: () => void;
}

export const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children, projectId }: { children: React.ReactNode; projectId?: string }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connectionState, setConnectionState] = useState<TelemetryConnectionState>('connecting');
  const [eventsReceived, setEventsReceived] = useState<number>(0);
  const [eventsPerSec, setEventsPerSec] = useState<number>(0);
  const [lastEventTime, setLastEventTime] = useState<number | null>(null);
  const [reconnectCount, setReconnectCount] = useState<number>(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [recentEvents, setRecentEvents] = useState<TelemetryEvent[]>([]);
  const [latencyMs, setLatencyMs] = useState<number>(0);

  const socketRef = useRef<Socket | null>(null);
  const eventsCountWindow = useRef<number>(0);
  const pingStartRef = useRef<number>(0);

  // Rate calculator (events per second)
  useEffect(() => {
    const rateInterval = setInterval(() => {
      setEventsPerSec(eventsCountWindow.current);
      eventsCountWindow.current = 0;
    }, 1000);
    return () => clearInterval(rateInterval);
  }, []);

  const pingServer = useCallback(() => {
    if (socketRef.current?.connected) {
      pingStartRef.current = Date.now();
      socketRef.current.emit('ping');
    }
  }, []);

  useEffect(() => {
    setConnectionState('connecting');

    const s = io(window.location.origin, {
      withCredentials: true,
      transports: ['polling', 'websocket'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000
    });

    socketRef.current = s;
    setSocket(s);

    s.on('connect', () => {
      setConnectionState('connected');
      setLastError(null);
      if (projectId) {
        s.emit('subscribe:project', projectId);
      }
    });

    s.on('reconnect_attempt', () => {
      setConnectionState('reconnecting');
      setReconnectCount(prev => prev + 1);
    });

    s.on('reconnect', () => {
      setConnectionState('connected');
      if (projectId) {
        s.emit('subscribe:project', projectId);
      }
    });

    s.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') {
        setConnectionState('failed');
      } else {
        setConnectionState('disconnected');
      }
    });

    s.on('connect_error', (err) => {
      setLastError(err.message);
      setConnectionState('degraded');
    });

    s.on('pong', () => {
      if (pingStartRef.current > 0) {
        setLatencyMs(Date.now() - pingStartRef.current);
        pingStartRef.current = 0;
      }
    });

    s.on('heartbeat', () => {
      setLastEventTime(Date.now());
    });

    const handleIncomingEvent = (event: TelemetryEvent) => {
      eventsCountWindow.current += 1;
      setEventsReceived(prev => prev + 1);
      setLastEventTime(Date.now());
      setRecentEvents(prev => [event, ...prev.slice(0, 49)]);
    };

    s.on('metric:batch', (events: any[]) => {
      if (Array.isArray(events)) {
        eventsCountWindow.current += events.length;
        setEventsReceived(prev => prev + events.length);
        setLastEventTime(Date.now());
      }
    });

    s.on('security:event', handleIncomingEvent);
    s.on('telemetry:security', handleIncomingEvent);
    s.on('experiment:state', handleIncomingEvent);
    s.on('settings:updated', handleIncomingEvent);

    return () => {
      s.disconnect();
      socketRef.current = null;
    };
  }, [projectId]);

  return (
    <SocketContext.Provider
      value={{
        socket,
        connectionState,
        eventsReceived,
        eventsPerSec,
        lastEventTime,
        reconnectCount,
        lastError,
        recentEvents,
        latencyMs,
        pingServer
      }}
    >
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
}

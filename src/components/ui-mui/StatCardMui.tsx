import { ReactNode } from 'react';
import { Paper, Stack, Typography } from '@mui/material';

interface StatCardMuiProps {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  valueColor?: string;
  sublabel?: string;
}

export default function StatCardMui({ icon, label, value, valueColor, sublabel }: StatCardMuiProps) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Stack direction="row" alignItems="center" spacing={0.75} color="text.secondary">
        {icon}
        <Typography variant="body2">{label}</Typography>
      </Stack>
      <Typography variant="h6" fontWeight={700} sx={{ color: valueColor || 'text.primary' }}>{value}</Typography>
      {sublabel && <Typography variant="caption" color="text.secondary">{sublabel}</Typography>}
    </Paper>
  );
}

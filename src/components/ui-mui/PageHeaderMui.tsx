import { ReactNode } from 'react';
import { Paper, Stack, Typography, Box } from '@mui/material';

interface PageHeaderMuiProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export default function PageHeaderMui({ icon, title, description, action }: PageHeaderMuiProps) {
  return (
    <Paper
      variant="outlined"
      sx={{ p: { xs: 2, md: 3 }, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2 }}
    >
      <Box>
        <Stack direction="row" alignItems="center" spacing={1}>
          {icon}
          <Typography variant="h5" fontWeight={700} color="text.primary">{title}</Typography>
        </Stack>
        {description && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {description}
          </Typography>
        )}
      </Box>
      {action}
    </Paper>
  );
}

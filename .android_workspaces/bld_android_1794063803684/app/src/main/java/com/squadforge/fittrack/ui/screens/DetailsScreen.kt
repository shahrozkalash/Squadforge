package com.squadforge.fittrack.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailsScreen(
    onNavigateBack: () -> Unit = {}
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Application Info") },
                navigationIcon = {
                    TextButton(onClick = onNavigateBack) {
                        Text("← Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Package: com.squadforge.fittrack", style = MaterialTheme.typography.bodyMedium)
                    Text("Target SDK: 34", style = MaterialTheme.typography.bodyMedium)
                    Text("Min SDK: 24", style = MaterialTheme.typography.bodyMedium)
                    Text("Version: 1.0.0 (1)", style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

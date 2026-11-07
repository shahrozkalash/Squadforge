package com.squadforge.fittrack.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.squadforge.fittrack.viewmodel.MainViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    modifier: Modifier = Modifier,
    onNavigateToDetails: () -> Unit = {},
    onNavigateToPermissions: () -> Unit = {},
    viewModel: MainViewModel = viewModel()
) {
    val items by viewModel.items.collectAsState()
    var textInput by remember { mutableStateOf("") }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "FitTrack",
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.primary
            )
            Row {
                IconButton(onClick = onNavigateToPermissions) {
                    Icon(Icons.Default.Lock, contentDescription = "Permissions")
                }
                IconButton(onClick = onNavigateToDetails) {
                    Icon(Icons.Default.Info, contentDescription = "Details")
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "Native Jetpack Compose Engine",
                    style = MaterialTheme.typography.titleMedium
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Clean architecture with declarative Compose Material3 components and reactive StateFlow.",
                    style = MaterialTheme.typography.bodyMedium
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedTextField(
                value = textInput,
                onValueChange = { textInput = it },
                label = { Text("Add New Item") },
                modifier = Modifier.weight(1f)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Button(
                onClick = {
                    if (textInput.isNotBlank()) {
                        viewModel.addItem(textInput)
                        textInput = ""
                    }
                }
            ) {
                Icon(Icons.Default.Add, contentDescription = "Add")
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "Active Items (${items.size})",
            style = MaterialTheme.typography.titleSmall
        )

        Spacer(modifier = Modifier.height(8.dp))

        LazyColumn(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(items) { item ->
                Card(
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text(text = item.title, style = MaterialTheme.typography.bodyLarge)
                            Text(text = item.timestamp, style = MaterialTheme.typography.labelSmall)
                        }
                        IconButton(onClick = { viewModel.removeItem(item.id) }) {
                            Text("✕", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
    }
}

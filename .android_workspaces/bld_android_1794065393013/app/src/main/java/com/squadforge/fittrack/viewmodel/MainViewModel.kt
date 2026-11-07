package com.squadforge.fittrack.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import com.squadforge.fittrack.data.model.ProjectItem
import java.text.SimpleDateFormat
import java.util.*

class MainViewModel : ViewModel() {
    private val _items = MutableStateFlow<List<ProjectItem>>(
        listOf(
            ProjectItem("1", "Initialize Android Jetpack Compose Architecture", "Just now"),
            ProjectItem("2", "Configure Kotlin Gradle DSL & ProGuard", "5 mins ago"),
            ProjectItem("3", "Verify AndroidManifest and Permission Grants", "10 mins ago")
        )
    )
    val items: StateFlow<List<ProjectItem>> = _items.asStateFlow()

    fun addItem(title: String) {
        viewModelScope.launch {
            val dateFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
            val newItem = ProjectItem(
                id = UUID.randomUUID().toString(),
                title = title,
                timestamp = dateFormat.format(Date())
            )
            _items.value = _items.value + newItem
        }
    }

    fun removeItem(id: String) {
        viewModelScope.launch {
            _items.value = _items.value.filter { it.id != id }
        }
    }
}
